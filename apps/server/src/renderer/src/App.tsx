import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createId,
  type ConnectedStudent,
  type FaceEnrollmentRequest,
  type PublishedTest,
  type Question,
  type ResultsArchive,
  type ServerSettings,
  type StoredResult,
  type StudentRosterEntry,
  type Test
} from '@test/shared'
import { extractFaceFromDataUrl, prepareFaceEngine } from './face-engine'

const API = 'http://127.0.0.1:4780/api'
type Tab = 'monitor' | 'tests' | 'results' | 'settings'

const parseRosterText = (value: string): Array<{ fish: string; group: string }> =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.includes('\t') ? '\t' : '|'
      const [fish = '', group = ''] = line.split(separator).map((part) => part.trim())
      return { fish, group }
    })
    .filter((entry) => {
      const fish = entry.fish.toLocaleLowerCase('uz-UZ').replace(/[\s.]/g, '')
      const group = entry.group.toLocaleLowerCase('uz-UZ').replace(/\s/g, '')
      return !(['fish', 'fio', 'f.i.sh'].includes(fish) && ['guruh', 'group'].includes(group))
    })

const emptyQuestion = (): Question => ({
  id: createId('q'),
  text: '',
  options: ['', '', '', ''],
  correctIndex: 0
})

const emptyTest = (): Test => {
  const now = new Date().toISOString()
  return {
    id: '',
    title: '',
    durationMinutes: 20,
    questionCount: 1,
    questionOrder: 'sequential',
    showResult: false,
    questions: [emptyQuestion()],
    createdAt: now,
    updatedAt: now
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers }
  })
  const body = await response.json().catch(() => ({})) as { message?: string }
  if (!response.ok) throw new Error(body.message || 'Server xatosi')
  return body as T
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('monitor')
  const [tests, setTests] = useState<Test[]>([])
  const [published, setPublished] = useState<PublishedTest[]>([])
  const [students, setStudents] = useState<ConnectedStudent[]>([])
  const [results, setResults] = useState<StoredResult[]>([])
  const [openedResults, setOpenedResults] = useState<{ archive: ResultsArchive; filePath: string } | null>(null)
  const [resultsFilePath, setResultsFilePath] = useState('')
  const [settings, setSettings] = useState<ServerSettings>({ identityMode: 'manual', accessMode: 'open', allowedIps: [] })
  const [roster, setRoster] = useState<StudentRosterEntry[]>([])
  const [faceProfileCount, setFaceProfileCount] = useState(0)
  const [faceEnrollmentRequests, setFaceEnrollmentRequests] = useState<FaceEnrollmentRequest[]>([])
  const [faceDataPath, setFaceDataPath] = useState('')
  const [testsDataPath, setTestsDataPath] = useState('')
  const [addresses, setAddresses] = useState<string[]>([])
  const [editing, setEditing] = useState<Test | null>(null)
  const editingRef = useRef(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    editingRef.current = editing !== null
  }, [editing])

  const refresh = useCallback(async () => {
    try {
      const [nextTests, nextPublished, nextStudents, nextResults, nextSettings, nextRoster, nextFaceCount, nextFaceRequests] = await Promise.all([
        request<Test[]>('/tests'),
        request<PublishedTest[]>('/published-tests'),
        request<ConnectedStudent[]>('/students'),
        request<StoredResult[]>('/results'),
        request<ServerSettings>('/settings'),
        request<StudentRosterEntry[]>('/roster'),
        request<{ count: number }>('/face/profiles/count'),
        request<FaceEnrollmentRequest[]>('/face/enrollment-requests')
      ])
      setTests(nextTests)
      setPublished(nextPublished)
      setStudents(nextStudents)
      setResults(nextResults)
      setSettings(nextSettings)
      setRoster(nextRoster)
      setFaceProfileCount(nextFaceCount.count)
      setFaceEnrollmentRequests(nextFaceRequests)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Server bilan aloqa xatosi')
    }
  }, [])

  useEffect(() => {
    void window.serverDesktop.getInfo().then((info) => {
      setAddresses(info.addresses)
      setResultsFilePath(info.resultsFilePath)
      setFaceDataPath(info.faceDataPath)
      setTestsDataPath(info.testsDataPath)
    })
    const removeListener = window.serverDesktop.onResultsSaved((filePath) => setResultsFilePath(filePath))
    void refresh()
    const timer = window.setInterval(() => {
      // Katta ro‘yxatlarni qayta render qilish test editoridagi aktiv inputni qotirmasin.
      if (!editingRef.current) void refresh()
    }, 1500)
    return () => {
      window.clearInterval(timer)
      removeListener()
    }
  }, [refresh])

  const notify = (text: string): void => {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 2600)
  }

  const saveTest = async (test: Test): Promise<void> => {
    const isNew = !test.id
    await request(isNew ? '/tests' : `/tests/${test.id}`, {
      method: isNew ? 'POST' : 'PUT',
      body: JSON.stringify(test)
    })
    setEditing(null)
    await refresh()
    notify(isNew ? 'Yangi test yaratildi' : 'Test yangilandi')
  }

  const deleteTest = async (test: Test): Promise<void> => {
    if (!window.confirm(`“${test.title}” testi o‘chirilsinmi?`)) return
    try {
      await request(`/tests/${test.id}`, { method: 'DELETE' })
      await refresh()
      notify('Test o‘chirildi')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Testni o‘chirib bo‘lmadi')
    }
  }

  const togglePublish = async (test: Test): Promise<void> => {
    const active = published.find((item) => item.testId === test.id)
    try {
      if (active) {
        if (!window.confirm('Test studentlar ro‘yxatidan olinsinmi? Faol urinishlar yakunlanadi.')) return
        await request(`/published-tests/${active.id}`, { method: 'DELETE' })
        notify('Test studentlardan olindi')
      } else {
        await request('/published-tests', { method: 'POST', body: JSON.stringify({ testId: test.id }) })
        notify('Test studentlarga yuborildi')
      }
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Amalni bajarib bo‘lmadi')
    }
  }

  const saveResults = async (): Promise<void> => {
    const result = await window.serverDesktop.saveResults()
    if (result.error) {
      setError(result.error)
    } else if (result.saved) {
      setResultsFilePath(result.filePath ?? '')
      notify('Joriy natijalar faylga saqlandi')
    }
  }

  const openResults = async (): Promise<void> => {
    const result = await window.serverDesktop.openResults()
    if (result.error) {
      setError(result.error)
    } else if (result.opened && result.archive && result.filePath) {
      setOpenedResults({ archive: result.archive, filePath: result.filePath })
      setTab('results')
      notify('Oldingi natijalar fayli ochildi')
    }
  }

  const downloadTestTemplate = async (): Promise<void> => {
    const result = await window.serverDesktop.downloadTestTemplate()
    if (result.saved) notify('Test Excel shabloni saqlandi')
  }

  const importTest = async (): Promise<void> => {
    try {
      const result = await window.serverDesktop.importTest()
      if (result.error) {
        setError(result.error)
      } else if (result.imported && result.test) {
        await saveTest(result.test)
        notify(`Excel testi import qilindi va kompyuterga saqlandi${result.warning ? `. ${result.warning}` : ''}`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Excel importida xato')
    }
  }

  const openTestsFolder = async (): Promise<void> => {
    const result = await window.serverDesktop.openTestsFolder()
    if (result.error) setError(result.error)
  }

  const working = students.filter((student) => student.status === 'working')
  const serverAddress = addresses.find((address) => !address.startsWith('127.')) ?? addresses[0] ?? '4780-port'

  return (
    <div className="server-shell">
      <header className="server-header">
        <div className="server-brand"><img className="brand-logo" src="/branding/logo.png" alt="Easy Testing Server" /><div><strong>Easy Testing Server</strong><span>O‘qituvchi boshqaruv paneli</span></div></div>
        <nav className="top-tabs">
          <TabButton active={tab === 'monitor'} label="Monitor" count={working.length + faceEnrollmentRequests.length} onClick={() => setTab('monitor')} />
          <TabButton active={tab === 'tests'} label="Testlar" count={tests.length} onClick={() => setTab('tests')} />
          <TabButton active={tab === 'results'} label="Natijalar" count={results.length} onClick={() => setTab('results')} />
          <TabButton active={tab === 'settings'} label="Sozlamalar" onClick={() => setTab('settings')} />
        </nav>
        <div className="server-online"><span /><div><small>Server IP (LAN)</small><strong>{serverAddress}</strong></div></div>
      </header>

      <main className="server-content">
        <div className="page-heading">
          <div>
            <span className="page-kicker">{tab === 'monitor' ? 'JONLI NAZORAT' : tab === 'tests' ? 'TEST BOSHQARUVI' : tab === 'results' ? 'JORIY NATIJALAR' : 'SERVER SOZLAMALARI'}</span>
            <h1>{tab === 'monitor' ? 'Monitor' : tab === 'tests' ? 'Testlar' : tab === 'results' ? 'Natijalar' : 'Sozlamalar'}</h1>
            <p>{tab === 'monitor' ? 'Hozir test ishlayotgan studentlarni real vaqtda kuzating.' : tab === 'tests' ? 'Test yarating yoki Excel shabloni orqali yuklang.' : tab === 'results' ? 'Joriy server sessiyasi yoki oldingi saqlangan fayl natijalarini ko‘ring.' : 'Studentni aniqlash usuli va server ro‘yxatini boshqaring.'}</p>
          </div>
          {tab === 'tests' && (
            <div className="page-actions">
              <button className="secondary" onClick={() => void downloadTestTemplate()}>Excel shabloni</button>
              <button className="secondary" onClick={() => void importTest()}>Exceldan yuklash</button>
              <button className="primary" onClick={() => setEditing(emptyTest())}>+ Yangi test</button>
            </div>
          )}
          {tab === 'results' && (
            <div className="page-actions">
              {openedResults
                ? <button className="secondary" onClick={() => setOpenedResults(null)}>Joriy natijalarga qaytish</button>
                : <button className="primary" onClick={() => void saveResults()}>Natijalarni saqlash</button>}
              <button className="secondary" onClick={() => void openResults()}>Oldingi natijani ochish</button>
              {!openedResults && <button className="secondary" onClick={() => void window.serverDesktop.exportResults()}>Excelga chiqarish</button>}
            </div>
          )}
        </div>

        {error && <div className="alert error">{error}<button onClick={() => setError('')}>×</button></div>}
        {message && <div className="toast">{message}</div>}
        {tab === 'monitor' && (
          <Monitor
            students={students}
            published={published}
            results={results}
            enrollmentRequests={faceEnrollmentRequests}
            onChanged={async (text) => { await refresh(); notify(text) }}
          />
        )}
        {tab === 'tests' && <Tests tests={tests} published={published} testsDataPath={testsDataPath} onOpenFolder={openTestsFolder} onEdit={setEditing} onDelete={deleteTest} onTogglePublish={togglePublish} />}
        {tab === 'results' && (
          <>
            {openedResults ? (
              <section className="panel archive-summary">
                <div>
                  <span className="archive-badge">OLDINGI NATIJALAR</span>
                  <h2>{new Date(openedResults.archive.startedAt).toLocaleString('uz-UZ')}</h2>
                  <p>{openedResults.archive.results.length} ta natija</p>
                  <small>{openedResults.filePath}</small>
                </div>
              </section>
            ) : resultsFilePath ? (
              <div className="results-storage-state"><span>✓</span><div><strong>Natijalar avtomatik saqlanmoqda</strong><small>{resultsFilePath}</small></div></div>
            ) : (
              <div className="results-storage-state warning"><span>!</span><div><strong>Joriy natijalar hali faylga saqlanmagan</strong><small>Server yopilganda saqlash so‘raladi.</small></div></div>
            )}
            <Results results={openedResults?.archive.results ?? results} />
          </>
        )}
        {tab === 'settings' && <Settings settings={settings} roster={roster} faceProfileCount={faceProfileCount} faceDataPath={faceDataPath} onFaceDataPathChanged={setFaceDataPath} onSaved={async () => { await refresh(); notify('Sozlamalar saqlandi') }} />}
      </main>

      {editing && <TestEditor initial={editing} onClose={() => setEditing(null)} onSave={saveTest} />}
    </div>
  )
}

function TabButton(props: { active: boolean; label: string; count?: number; onClick: () => void }): React.JSX.Element {
  return <button className={props.active ? 'top-tab active' : 'top-tab'} onClick={props.onClick}>{props.label}{props.count !== undefined && <b>{props.count}</b>}</button>
}

function Monitor(props: {
  students: ConnectedStudent[]
  published: PublishedTest[]
  results: StoredResult[]
  enrollmentRequests: FaceEnrollmentRequest[]
  onChanged: (message: string) => Promise<void>
}): React.JSX.Element {
  const working = props.students.filter((student) => student.status === 'working')
  const [selectedRequest, setSelectedRequest] = useState<FaceEnrollmentRequest | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [group, setGroup] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (selectedRequest) {
      const updated = props.enrollmentRequests.find((item) => item.id === selectedRequest.id)
      if (updated) setSelectedRequest(updated)
      return
    }
    const scanned = props.enrollmentRequests.find((item) => item.status === 'scanned')
    if (scanned) setSelectedRequest(scanned)
  }, [props.enrollmentRequests, selectedRequest])

  const closeEnrollment = (): void => {
    setSelectedRequest(null)
    setFirstName('')
    setLastName('')
    setGroup('')
    setError('')
  }

  const approveEnrollment = async (): Promise<void> => {
    if (!selectedRequest) return
    if (!firstName.trim() || !lastName.trim() || !group.trim()) {
      setError('Ism, familiya va guruhni to‘liq kiriting')
      return
    }
    setSaving(true)
    setError('')
    try {
      await request(`/face/enrollment-requests/${selectedRequest.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), group: group.trim() })
      })
      closeEnrollment()
      await props.onChanged('Yangi student Face ID bazasiga qo‘shildi')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Studentni saqlashda xato')
    } finally {
      setSaving(false)
    }
  }

  const rejectEnrollment = async (requestItem: FaceEnrollmentRequest): Promise<void> => {
    try {
      await request(`/face/enrollment-requests/${requestItem.id}/reject`, { method: 'POST', body: '{}' })
      if (selectedRequest?.id === requestItem.id) closeEnrollment()
      await props.onChanged('Face ID so‘rovi rad etildi')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'So‘rovni rad etishda xato')
    }
  }

  const startEnrollmentScan = async (requestItem: FaceEnrollmentRequest): Promise<void> => {
    try {
      await request(`/face/enrollment-requests/${requestItem.id}/start-scan`, { method: 'POST', body: '{}' })
      await props.onChanged(`${requestItem.computerName} kompyuterida yuz skanerlash boshlandi`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skanerlashni boshlashda xato')
    }
  }
  return (
    <>
      <section className="metric-grid">
        <Metric label="Ishlayapti" value={working.length} hint="Faol studentlar" tone="blue" />
        <Metric label="Onlayn" value={props.students.length} hint="Serverga ulangan" tone="green" />
        <Metric label="Yuborilgan test" value={props.published.length} hint="Tanlash uchun ochiq" tone="violet" />
        <Metric label="Yakunlangan" value={props.results.length} hint="Jami natijalar" tone="orange" />
      </section>
      {props.enrollmentRequests.length > 0 && (
        <section className="panel face-request-panel">
          <div className="panel-title">
            <div><h2>Yangi Face ID so‘rovlari</h2><p>Skanerlashni serverdan boshlang, keyin student ma’lumotlarini kiriting</p></div>
            <span className="roster-count">{props.enrollmentRequests.length} ta kutilmoqda</span>
          </div>
          <div className="face-request-grid">
            {props.enrollmentRequests.map((requestItem) => (
              <article key={requestItem.id}>
                {requestItem.photoDataUrl
                  ? <img src={requestItem.photoDataUrl} alt="Skanerlangan yuz" />
                  : <div className="face-request-placeholder">◎</div>}
                <div><strong>{requestItem.computerName}</strong><small>{new Date(requestItem.requestedAt).toLocaleTimeString('uz-UZ')} · {requestItem.deviceId.slice(0, 8)}</small></div>
                {requestItem.status === 'pending' && (
                  <button className="primary" onClick={() => void startEnrollmentScan(requestItem)}>Skanerlash</button>
                )}
                {requestItem.status === 'scan_requested' && <span className="face-request-state">Skanerlanmoqda...</span>}
                {requestItem.status === 'scanned' && (
                  <button className="primary" onClick={() => { setSelectedRequest(requestItem); setError('') }}>Ma’lumot kiritish</button>
                )}
                <button className="secondary" onClick={() => void rejectEnrollment(requestItem)}>Rad etish</button>
              </article>
            ))}
          </div>
        </section>
      )}
      <section className="panel monitor-panel">
        <div className="panel-title"><div><h2>Studentlar holati</h2><p>Jarayon 1.5 soniyada yangilanadi</p></div><span className="live-badge">● LIVE</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Student</th><th>Kompyuter</th><th>Test</th><th>Joriy savol</th><th>Progress</th><th>Boshlagan vaqt</th><th>Holat</th></tr></thead>
            <tbody>
              {props.students.map((student) => {
                const progress = student.totalQuestions ? Math.round(((student.answeredCount ?? 0) / student.totalQuestions) * 100) : 0
                return (
                  <tr key={student.deviceId}>
                    <td><strong>{student.fish}</strong><small className="cell-sub">{student.group}</small></td>
                    <td><span className="computer-name">{student.computerName}</span></td>
                    <td>{student.testTitle ?? 'Test tanlamagan'}</td>
                    <td>{student.status === 'working' ? `${student.currentQuestion ?? 1} / ${student.totalQuestions ?? 0}` : '—'}</td>
                    <td><div className="mini-progress"><div style={{ width: `${progress}%` }} /></div><small>{student.answeredCount ?? 0}/{student.totalQuestions ?? 0}</small></td>
                    <td>{student.startedAt ? new Date(student.startedAt).toLocaleTimeString('uz-UZ') : '—'}</td>
                    <td><Status status={student.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!props.students.length && <div className="empty-state">Hozircha serverga student ulanmagan.</div>}
      </section>
      {selectedRequest?.status === 'scanned' && selectedRequest.photoDataUrl && (
        <div className="modal-backdrop">
          <div className="modal face-registration-modal">
            <div className="modal-header">
              <div><h2>Yangi studentni Face ID bazasiga qo‘shish</h2><p>{selectedRequest.computerName} kompyuterida olingan yuz</p></div>
              <button className="close" onClick={closeEnrollment}>×</button>
            </div>
            <div className="editor-body face-request-editor">
              <img src={selectedRequest.photoDataUrl} alt="Student yuzi" />
              <div>
                {error && <div className="alert error">{error}</div>}
                <div className="form-grid face-request-form">
                  <label><span>Ism</span><input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="Ali" autoFocus /></label>
                  <label><span>Familiya</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Aliyev" /></label>
                  <label><span>Guruh</span><input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="101-guruh" /></label>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary" disabled={saving} onClick={() => void rejectEnrollment(selectedRequest)}>Rad etish</button>
              <button className="primary" disabled={saving} onClick={() => void approveEnrollment()}>{saving ? 'Saqlanmoqda...' : 'Tasdiqlash va qo‘shish'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Status({ status }: { status: ConnectedStudent['status'] }): React.JSX.Element {
  return <span className={`status status-${status}`}>● {status === 'working' ? 'Ishlayapti' : status === 'completed' ? 'Yakunladi' : 'Ulangan'}</span>
}

function Metric({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: string }): React.JSX.Element {
  return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>
}

function Tests(props: {
  tests: Test[]
  published: PublishedTest[]
  testsDataPath: string
  onOpenFolder: () => Promise<void>
  onEdit: (test: Test) => void
  onDelete: (test: Test) => Promise<void>
  onTogglePublish: (test: Test) => Promise<void>
}): React.JSX.Element {
  return (
    <>
      <div className="tests-storage-state">
        <span>✓</span>
        <div><strong>Testlar lokal saqlanmoqda</strong><small>{props.testsDataPath || 'Documents\\Test ishlash dasturi\\tests'}</small></div>
        <button className="secondary mini" onClick={() => void props.onOpenFolder()}>Testlar papkasini ochish</button>
      </div>
      <div className="test-grid">
        {props.tests.map((test) => {
          const active = props.published.some((item) => item.testId === test.id)
          return (
            <article className={active ? 'test-card published' : 'test-card'} key={test.id}>
              <div className="test-card-top"><span>{active ? '● STUDENTLARGA YUBORILGAN' : 'TEST'}</span><button className="icon-button" onClick={() => props.onEdit(test)}>✎</button></div>
              <h3>{test.title}</h3>
              <div className="rules-list">
                <span>⏱ {test.durationMinutes} daqiqa</span>
                <span>☷ {test.questionCount} / {test.questions.length} savol</span>
                <span>{test.questionOrder === 'random' ? '⤨ Random' : '→ Ketma-ket'}</span>
                <span>{test.showResult ? '✓ Natija ko‘rinadi' : '◉ Natija yashirin'}</span>
              </div>
              <div className="test-actions">
                <button className={active ? 'unpublish' : 'primary'} onClick={() => void props.onTogglePublish(test)}>{active ? 'Studentlardan olish' : 'Studentlarga yuborish'}</button>
                <button className="secondary" onClick={() => props.onEdit(test)}>Tahrirlash</button>
                <button className="icon-button delete" onClick={() => void props.onDelete(test)}>×</button>
              </div>
            </article>
          )
        })}
        {!props.tests.length && <div className="empty-state">Hali test yaratilmagan.</div>}
      </div>
    </>
  )
}

function Results({ results }: { results: StoredResult[] }): React.JSX.Element {
  const [selected, setSelected] = useState<StoredResult | null>(null)
  const duration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <section className="panel">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Student</th><th>Kompyuter</th><th>Test</th><th>Natija</th><th>Davomiyligi</th><th>Boshladi</th><th>Tugatdi</th><th /></tr></thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.id}>
                <td><strong>{result.fish}</strong><small className="cell-sub">{result.group}</small></td>
                <td>{result.computerName || '—'}</td><td>{result.testTitle}</td><td><span className={`score ${result.percentage >= 70 ? 'good' : result.percentage >= 50 ? 'mid' : 'low'}`}>{result.score}/{result.total} · {result.percentage}%</span></td>
                <td>{duration(result.durationSeconds)}</td><td>{new Date(result.startedAt).toLocaleString('uz-UZ')}</td><td>{new Date(result.submittedAt).toLocaleString('uz-UZ')}</td>
                <td><button className="detail-button" onClick={() => setSelected(result)}>Javoblar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!results.length && <div className="empty-state">Natijalar hali mavjud emas.</div>}
      {selected && <ResultDetails result={selected} onClose={() => setSelected(null)} />}
    </section>
  )
}

function ResultDetails({ result, onClose }: { result: StoredResult; onClose: () => void }): React.JSX.Element {
  return (
    <div className="modal-backdrop">
      <div className="modal result-modal">
        <div className="modal-header"><div><h2>{result.fish}</h2><p>{result.testTitle} · {result.score}/{result.total} · {result.percentage}%</p></div><button className="close" onClick={onClose}>×</button></div>
        <div className="answer-details">
          {result.answerOutcomes.map((item, index) => (
            <div className={item.isCorrect ? 'answer-detail correct' : 'answer-detail wrong'} key={item.questionId}>
              <div className="answer-number">{index + 1}</div>
              <div><strong>{item.questionText}</strong><p>Student javobi: <b>{item.selectedAnswer ?? 'Javob berilmagan'}</b></p>{!item.isCorrect && <p>To‘g‘ri javob: <b>{item.correctAnswer}</b></p>}</div>
              <span>{item.isCorrect ? 'TO‘G‘RI' : 'NOTO‘G‘RI'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Settings(props: {
  settings: ServerSettings
  roster: StudentRosterEntry[]
  faceProfileCount: number
  faceDataPath: string
  onFaceDataPathChanged: (directory: string) => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [mode, setMode] = useState(props.settings.identityMode)
  const [accessMode, setAccessMode] = useState(props.settings.accessMode)
  const [allowedIpsText, setAllowedIpsText] = useState(() => props.settings.allowedIps.join(', '))
  const [text, setText] = useState(() => props.roster.map((item) => `${item.fish} | ${item.group}`).join('\n'))
  const [saving, setSaving] = useState(false)
  const [faceImporting, setFaceImporting] = useState(false)
  const [faceProgress, setFaceProgress] = useState('')
  const [error, setError] = useState('')
  const [registrationOpen, setRegistrationOpen] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('Tugmani bosib yangi versiya borligini tekshiring.')
  const [registration, setRegistration] = useState({
    firstName: '',
    lastName: '',
    group: '',
    photoDataUrl: '',
    photoName: ''
  })

  const downloadTemplate = async (): Promise<void> => {
    await window.serverDesktop.downloadRosterTemplate()
  }

  const importRoster = async (): Promise<void> => {
    try {
      const result = await window.serverDesktop.importRoster()
      if (result.error) {
        setError(result.error)
      } else if (result.imported && result.entries) {
        await request('/settings', { method: 'PUT', body: JSON.stringify({ identityMode: 'roster' }) })
        await request('/roster', { method: 'PUT', body: JSON.stringify(result.entries) })
        setMode('roster')
        setText(result.entries.map((item) => `${item.fish} | ${item.group}`).join('\n'))
        setError('')
        await props.onSaved()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Excel importida xato')
    }
  }

  const downloadFaceTemplate = async (): Promise<void> => {
    await window.serverDesktop.downloadFaceTemplate()
  }

  const chooseFaceFolder = async (): Promise<string | null> => {
    const result = await window.serverDesktop.chooseFaceFolder()
    if (result.error) {
      setError(result.error)
      return null
    }
    if (result.selected && result.directory) {
      props.onFaceDataPathChanged(result.directory)
      setError('')
      setFaceProgress('Face ID rasmlari shu papkaga saqlanadi')
      await props.onSaved()
      return result.directory
    }
    return null
  }

  const openFaceFolder = async (): Promise<void> => {
    const result = await window.serverDesktop.openFaceFolder()
    if (result.error) setError(result.error)
  }

  const importFaceDatabase = async (): Promise<void> => {
    setFaceImporting(true)
    setError('')
    setFaceProgress('ZIP baza ochilmoqda...')
    try {
      const result = await window.serverDesktop.importFaceDatabase()
      if (result.error) {
        setError(result.error)
        return
      }
      if (!result.imported || !result.entries?.length) return
      if (result.directory) props.onFaceDataPathChanged(result.directory)
      await prepareFaceEngine()
      const profiles = []
      for (let index = 0; index < result.entries.length; index += 1) {
        const entry = result.entries[index]
        setFaceProgress(`${index + 1}/${result.entries.length}: ${entry.fish} yuzi tekshirilmoqda...`)
        try {
          const descriptor = await extractFaceFromDataUrl(entry.photoDataUrl)
          profiles.push({
            id: entry.id,
            fish: entry.fish,
            group: entry.group,
            descriptor,
            photoDataUrl: entry.photoDataUrl
          })
        } catch (reason) {
          throw new Error(`${entry.fish}: ${reason instanceof Error ? reason.message : 'yuzni o‘qib bo‘lmadi'}`)
        }
      }
      await request('/face/profiles', { method: 'PUT', body: JSON.stringify(profiles) })
      await request('/settings', { method: 'PUT', body: JSON.stringify({ identityMode: 'face' }) })
      setMode('face')
      setText(profiles.map((item) => `${item.fish} | ${item.group}`).join('\n'))
      setFaceProgress(
        `${profiles.length} ta Face ID profil tashqi papkaga saqlandi${result.warning ? `. ${result.warning}` : ''}`
      )
      await props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Face ID bazasini import qilishda xato')
    } finally {
      setFaceImporting(false)
    }
  }

  const openRegistration = async (): Promise<void> => {
    if (!props.faceDataPath && !await chooseFaceFolder()) return
    setRegistrationOpen(true)
    setError('')
  }

  const pickRegistrationPhoto = async (): Promise<void> => {
    const result = await window.serverDesktop.pickFacePhoto()
    if (result.error) return setError(result.error)
    if (result.selected && result.photoDataUrl) {
      setRegistration((current) => ({
        ...current,
        photoDataUrl: result.photoDataUrl ?? '',
        photoName: result.fileName ?? 'Rasm tanlandi'
      }))
      setError('')
    }
  }

  const registerFace = async (): Promise<void> => {
    const firstName = registration.firstName.trim()
    const lastName = registration.lastName.trim()
    const group = registration.group.trim()
    if (!firstName || !lastName || !group) return setError('Ism, familiya va guruhni to‘liq kiriting')
    if (!registration.photoDataUrl) return setError('Studentning yuz rasmini tanlang')
    setRegistering(true)
    setError('')
    try {
      setFaceProgress(`${lastName} ${firstName} yuz rasmi tekshirilmoqda...`)
      const descriptor = await extractFaceFromDataUrl(registration.photoDataUrl)
      const fish = `${lastName} ${firstName}`
      await request('/face/register', {
        method: 'POST',
        body: JSON.stringify({
          fish,
          group,
          descriptor,
          photoDataUrl: registration.photoDataUrl
        })
      })
      await request('/settings', { method: 'PUT', body: JSON.stringify({ identityMode: 'face' }) })
      setMode('face')
      setFaceProgress(`${fish} registratsiya qilindi. Rasm Face ID papkasiga saqlandi.`)
      setRegistration({ firstName: '', lastName: '', group: '', photoDataUrl: '', photoName: '' })
      setRegistrationOpen(false)
      await props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Face ID registratsiyasida xato')
    } finally {
      setRegistering(false)
    }
  }

  const deleteFaceProfile = async (student: StudentRosterEntry): Promise<void> => {
    if (!window.confirm(`${student.fish}ning Face ID rasmi va profili o‘chirilsinmi?`)) return
    try {
      await request(`/face/profiles/${student.id}`, { method: 'DELETE' })
      setFaceProgress(`${student.fish}ning rasmi o‘chirildi`)
      await props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Face ID rasmini o'chirib bo'lmadi")
    }
  }

  const pasteRoster = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const clipboardText = event.clipboardData.getData('text')
    if (!clipboardText.includes('\t')) return
    const pastedEntries = parseRosterText(clipboardText).filter((entry) => entry.fish && entry.group)
    if (!pastedEntries.length) return

    event.preventDefault()
    const formatted = pastedEntries.map((entry) => `${entry.fish} | ${entry.group}`).join('\n')
    const target = event.currentTarget
    const before = text.slice(0, target.selectionStart)
    const after = text.slice(target.selectionEnd)
    const prefix = before && !before.endsWith('\n') ? '\n' : ''
    const suffix = after && !after.startsWith('\n') ? '\n' : ''
    setText(`${before}${prefix}${formatted}${suffix}${after}`)
    setError('')
  }

  const save = async (): Promise<void> => {
    const entries = parseRosterText(text).map(({ fish, group }) => ({ id: createId('student'), fish, group }))
    if (mode === 'roster' && (!entries.length || entries.some((item) => !item.fish || !item.group))) {
      return setError("Ro'yxatni “F.I.Sh | Guruh” ko'rinishida to'ldiring yoki Excelning F.I.Sh va Guruh ustunlarini nusxalab qo'ying")
    }
    setSaving(true)
    setError('')
    try {
      await request('/settings', { method: 'PUT', body: JSON.stringify({ identityMode: mode }) })
      if (mode === 'roster') {
        await request('/roster', { method: 'PUT', body: JSON.stringify(entries.filter((item) => item.fish && item.group)) })
      }
      await props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Saqlash xatosi')
    } finally {
      setSaving(false)
    }
  }

  const saveNetworkAccess = async (): Promise<void> => {
    const allowedIps = allowedIpsText.split(',').map((value) => value.trim()).filter(Boolean)
    if (accessMode === 'restricted' && !allowedIps.length) {
      return setError('Yopiq rejim uchun kamida bitta IP manzil yozing')
    }
    setSaving(true)
    setError('')
    try {
      const saved = await request<ServerSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ accessMode, allowedIps })
      })
      setAccessMode(saved.accessMode)
      setAllowedIpsText(saved.allowedIps.join(', '))
      await props.onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'IP ruxsatlarini saqlashda xato')
    } finally {
      setSaving(false)
    }
  }

  const checkForUpdates = async (): Promise<void> => {
    setUpdateChecking(true)
    setUpdateMessage('GitHub orqali yangilanish tekshirilmoqda...')
    try {
      const result = await window.serverDesktop.checkForUpdates()
      setUpdateMessage(result.message)
    } catch (reason) {
      setUpdateMessage(reason instanceof Error ? reason.message : 'Yangilanishni tekshirib bo‘lmadi.')
    } finally {
      setUpdateChecking(false)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel network-access-panel">
        <div className="panel-title"><div><h2>Serverga ulanish ruxsati</h2><p>Qaysi student kompyuterlari serverga ulanishini belgilang</p></div><span className={accessMode === 'open' ? 'access-state open' : 'access-state restricted'}>{accessMode === 'open' ? 'HAMMAGA OCHIQ' : 'IP BO‘YICHA YOPIQ'}</span></div>
        <div className="access-mode-cards">
          <button className={accessMode === 'open' ? 'mode-card active' : 'mode-card'} onClick={() => setAccessMode('open')}><span>◉</span><strong>Hammaga ochiq</strong><small>Lokal tarmoqdagi barcha kompyuterlar ulana oladi</small></button>
          <button className={accessMode === 'restricted' ? 'mode-card active' : 'mode-card'} onClick={() => setAccessMode('restricted')}><span>▣</span><strong>Faqat ruxsat berilgan IP’lar</strong><small>Faqat quyidagi ro‘yxatdagi IP manzillar ulanadi</small></button>
        </div>
        <div className="allowed-ip-editor">
          <label><span>Ruxsat berilgan IP manzillar</span><textarea value={allowedIpsText} onChange={(event) => setAllowedIpsText(event.target.value)} rows={3} placeholder="192.168.1.10, 192.168.1.11, 192.168.1.12" /></label>
          <small>IP manzillarni vergul bilan ajrating. Ochiq rejimga o‘tganda bu ro‘yxat saqlanib qoladi.</small>
        </div>
        {error && <div className="alert error network-access-error">{error}</div>}
        <div className="settings-footer"><small>Server kompyuterining o‘zi har doim ruxsat etiladi.</small><button className="primary" disabled={saving} onClick={() => void saveNetworkAccess()}>{saving ? 'Saqlanmoqda...' : 'Ulanish ruxsatini saqlash'}</button></div>
      </section>
      <section className="panel update-panel">
        <div className="panel-title"><div><h2>Dastur yangilanishi</h2><p>Easy Testing Server yangi versiyasini tekshiring va yuklab oling</p></div><span className="update-icon">↻</span></div>
        <div className="update-content"><div><strong>GitHub avtomatik yangilanishi</strong><small>{updateMessage}</small></div><button className="primary" disabled={updateChecking} onClick={() => void checkForUpdates()}>{updateChecking ? 'Tekshirilmoqda...' : 'Yangilanishni tekshirish'}</button></div>
      </section>
      <section className="panel">
        <div className="panel-title"><div><h2>Student ma’lumotini olish</h2><p>Student dasturida F.I.Sh qanday kiritilishini belgilang</p></div></div>
        <div className="mode-cards">
          <button className={mode === 'manual' ? 'mode-card active' : 'mode-card'} onClick={() => setMode('manual')}><span>⌨</span><strong>Qo‘lda yozish</strong><small>Student F.I.Sh va guruhni o‘zi kiritadi</small></button>
          <button className={mode === 'roster' ? 'mode-card active' : 'mode-card'} onClick={() => setMode('roster')}><span>☷</span><strong>Server ro‘yxati</strong><small>Student server yuborgan ro‘yxatdan tanlaydi</small></button>
          <button className={mode === 'face' ? 'mode-card active' : 'mode-card'} onClick={() => setMode('face')}><span>◎</span><strong>Face ID</strong><small>Student webcam orqali yuzini skaner qiladi</small></button>
        </div>
      </section>
      {mode === 'manual' ? (
        <section className="panel">
          <div className="panel-title">
            <div><h2>Qo‘lda yozish rejimi</h2><p>Student dasturida F.I.Sh va guruh maydonlari ochiladi</p></div>
            <span className="mode-state">Qo‘lda</span>
          </div>
          <div className="manual-mode-summary">
            <div><span>1</span><strong>Student serverga ulanadi</strong><small>Server IP manzili kiritilgach keyingi oynaga o‘tadi.</small></div>
            <div><span>2</span><strong>F.I.Sh va guruhni o‘zi yozadi</strong><small>Server ro‘yxati yoki Face ID talab qilinmaydi.</small></div>
            <div><span>3</span><strong>Testni tanlab boshlaydi</strong><small>Yuborilgan testlar ro‘yxati avvalgidek ko‘rinadi.</small></div>
          </div>
          {error && <div className="alert error">{error}</div>}
          <div className="settings-footer">
            <small>Server ro‘yxati va Face ID bazasi o‘zgartirilmaydi.</small>
            <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saqlanmoqda...' : 'Qo‘lda yozish rejimini saqlash'}</button>
          </div>
        </section>
      ) : mode === 'face' ? (
        <section className="panel">
          <div className="panel-title">
            <div><h2>Face ID talabalar bazasi</h2><p>Excel ro‘yxati va rasmlar papkasi ZIP shablonda yuklanadi</p></div>
            <span className="roster-count">{props.faceProfileCount} ta profil</span>
          </div>
          <div className="face-db-tools">
            <div className="face-db-help">
              <strong>Import tartibi</strong>
              <ol>
                <li>ZIP shablonni yuklab oling va ichidagi Excelni to‘ldiring.</li>
                <li>Rasmlarni Excelda yozilgan nom bilan <code>rasmlar</code> papkasiga joylang.</li>
                <li>ZIP faylni qayta import qiling — yuz shablonlari avtomatik yaratiladi.</li>
              </ol>
            </div>
            <div className="face-db-buttons">
              <button className="primary" onClick={() => void openRegistration()}>
                + Rasm orqali registratsiya
              </button>
              <button className="secondary" onClick={() => void chooseFaceFolder()}>
                {props.faceDataPath ? 'Face ID papkasini almashtirish' : 'Face ID papkasini tanlash'}
              </button>
              <button className="secondary" disabled={!props.faceDataPath} onClick={() => void openFaceFolder()}>
                Papkani ochish
              </button>
              <button className="secondary" onClick={() => void downloadFaceTemplate()}>Face ID ZIP shabloni</button>
              <button className="primary" disabled={faceImporting} onClick={() => void importFaceDatabase()}>
                {faceImporting ? 'Yuzlar tekshirilmoqda...' : 'Face ID bazani import qilish'}
              </button>
            </div>
          </div>
          <div className={props.faceDataPath ? 'face-folder-path' : 'face-folder-path missing'}>
            <strong>Saqlash papkasi:</strong>
            <span>{props.faceDataPath || 'Tanlanmagan. Import yoki registratsiyadan oldin papkani tanlang.'}</span>
          </div>
          {faceProgress && <div className="face-import-progress">{faceProgress}</div>}
          {error && <div className="alert error">{error}</div>}
          <div className="face-profile-list">
            {props.roster.map((student) => (
              <div key={student.id}>
                <span>◎</span>
                <strong>{student.fish}</strong>
                <small>{student.group}</small>
                <button className="face-delete-button" onClick={() => void deleteFaceProfile(student)}>Rasmni o‘chirish</button>
              </div>
            ))}
            {!props.roster.length && <div className="empty-state">Face ID bazasi hali yuklanmagan.</div>}
          </div>
          <div className="settings-footer"><small>Studentdagi noma’lum yuz so‘rovlari serverning Monitor qismida o‘qituvchi tomonidan tasdiqlanadi.</small><button className="primary" disabled={saving} onClick={() => void save()}>Face ID rejimini saqlash</button></div>
          {registrationOpen && (
            <div className="modal-backdrop">
              <div className="modal face-registration-modal">
                <div className="modal-header">
                  <div><h2>Face ID registratsiya</h2><p>Student ma’lumotlari va yuz rasmini kiriting.</p></div>
                  <button className="close" onClick={() => setRegistrationOpen(false)}>×</button>
                </div>
                <div className="editor-body">
                  {error && <div className="alert error">{error}</div>}
                  <div className="form-grid">
                    <label><span>Ism</span><input value={registration.firstName} onChange={(event) => setRegistration({ ...registration, firstName: event.target.value })} placeholder="Ali" /></label>
                    <label><span>Familiya</span><input value={registration.lastName} onChange={(event) => setRegistration({ ...registration, lastName: event.target.value })} placeholder="Aliyev" /></label>
                    <label><span>Guruh</span><input value={registration.group} onChange={(event) => setRegistration({ ...registration, group: event.target.value })} placeholder="101-guruh" /></label>
                  </div>
                  <button className={registration.photoDataUrl ? 'photo-picker selected' : 'photo-picker'} onClick={() => void pickRegistrationPhoto()}>
                    <span>{registration.photoDataUrl ? '✓' : '＋'}</span>
                    <div><strong>{registration.photoName || 'Yuz rasmini tanlash'}</strong><small>JPG, JPEG yoki PNG · rasmda bitta yuz bo‘lsin</small></div>
                  </button>
                </div>
                <div className="modal-footer">
                  <button className="secondary" onClick={() => setRegistrationOpen(false)}>Bekor qilish</button>
                  <button className="primary" disabled={registering} onClick={() => void registerFace()}>{registering ? 'Yuz tekshirilmoqda...' : 'Registratsiya qilish'}</button>
                </div>
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="panel">
        <div className="panel-title">
          <div><h2>Server ro‘yxati</h2><p>Student dasturida shu ro‘yxatdan tanlash oynasi ochiladi</p></div>
          <div className="panel-actions">
            <span className="roster-count">{text.split('\n').filter((line) => line.trim()).length} ta</span>
            <button className="secondary mini" onClick={() => void downloadTemplate()}>Excel shabloni</button>
            <button className="primary mini" onClick={() => void importRoster()}>Exceldan yuklash</button>
          </div>
        </div>
        <textarea value={text} onChange={(event) => setText(event.target.value)} onPaste={pasteRoster} rows={12} placeholder={'Aliyev Ali Valiyevich | 101-guruh\nKarimova Malika | 102-guruh'} />
        <small className="paste-hint">Excelda F.I.Sh va Guruh ustunlarini belgilang, nusxalang (Ctrl+C) va shu maydonga qo‘ying (Ctrl+V).</small>
        {error && <div className="alert error">{error}</div>}
        <div className="settings-footer"><small>Student serverdan ro‘yxatni olib, faqat o‘zini tanlaydi.</small><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saqlanmoqda...' : 'Server ro‘yxati rejimini saqlash'}</button></div>
        </section>
      )}
    </div>
  )
}

function TestEditor({ initial, onClose, onSave }: { initial: Test; onClose: () => void; onSave: (test: Test) => Promise<void> }): React.JSX.Element {
  const [test, setTest] = useState<Test>(() => structuredClone(initial))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const updateQuestion = (index: number, patch: Partial<Question>): void => {
    setTest((current) => ({ ...current, questions: current.questions.map((question, qIndex) => qIndex === index ? { ...question, ...patch } : question) }))
  }
  const updateOption = (questionIndex: number, optionIndex: number, value: string): void => {
    setTest((current) => ({
      ...current,
      questions: current.questions.map((question, index) => {
        if (index !== questionIndex) return question
        const options = [...question.options]
        options[optionIndex] = value
        return { ...question, options }
      })
    }))
  }
  const submit = async (): Promise<void> => {
    if (!test.title.trim()) return setError('Test nomini kiriting')
    if (test.questionCount < 1 || test.questionCount > test.questions.length) return setError('Studentga tushadigan savollar soni umumiy savollardan oshmasin')
    if (test.questions.some((question) => !question.text.trim() || question.options.some((option) => !option.trim()))) return setError('Barcha savol va variantlarni to‘ldiring')
    setSaving(true)
    try { await onSave(test) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Saqlashda xato'); setSaving(false) }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header"><div><h2>{test.id ? 'Testni tahrirlash' : 'Yangi test yaratish'}</h2><p>Savollar va student uchun ishlash qoidalarini belgilang.</p></div><button className="close" onClick={onClose}>×</button></div>
        <div className="editor-body">
          {error && <div className="alert error">{error}</div>}
          <div className="settings-box">
            <h3>Test sozlamalari</h3>
            <div className="form-grid four">
              <label><span>Test nomi</span><input value={test.title} onChange={(event) => setTest((current) => ({ ...current, title: event.target.value }))} placeholder="Masalan: Informatika testi" /></label>
              <label><span>Chegaralangan vaqt</span><input type="number" min={1} value={test.durationMinutes} onChange={(event) => setTest((current) => ({ ...current, durationMinutes: Math.max(1, Number(event.target.value)) }))} /></label>
              <label><span>Studentga tushadigan savol</span><input type="number" min={1} max={test.questions.length} value={test.questionCount} onChange={(event) => setTest((current) => ({ ...current, questionCount: Math.max(1, Number(event.target.value)) }))} /></label>
              <label><span>Savollar tartibi</span><select value={test.questionOrder} onChange={(event) => setTest((current) => ({ ...current, questionOrder: event.target.value as Test['questionOrder'] }))}><option value="sequential">To‘g‘ri ketma-ketlik</option><option value="random">Random</option></select></label>
            </div>
            <label className="toggle-row"><input type="checkbox" checked={test.showResult} onChange={(event) => setTest((current) => ({ ...current, showResult: event.target.checked }))} /><span><strong>Natijani studentga ko‘rsatish</strong><small>Test tugagach ball va foiz student ekranida chiqadi</small></span></label>
          </div>
          <div className="questions-heading"><h3>Savollar</h3><span>{test.questions.length} ta</span></div>
          {test.questions.map((question, index) => (
            <div className="question-editor" key={question.id}>
              <div className="question-number">{index + 1}</div>
              <div className="question-fields">
                <input className="question-input" value={question.text} onChange={(event) => updateQuestion(index, { text: event.target.value })} placeholder="Savol matnini kiriting" />
                <div className="options-grid">
                  {question.options.map((option, optionIndex) => (
                    <label className={question.correctIndex === optionIndex ? 'option-input correct' : 'option-input'} key={optionIndex}>
                      <input type="radio" name={`correct-${question.id}`} checked={question.correctIndex === optionIndex} onChange={() => updateQuestion(index, { correctIndex: optionIndex })} />
                      <input value={option} onChange={(event) => updateOption(index, optionIndex, event.target.value)} placeholder={`${String.fromCharCode(65 + optionIndex)} variant`} />
                    </label>
                  ))}
                </div>
              </div>
              <button className="remove-question" disabled={test.questions.length === 1} onClick={() => {
                const questions = test.questions.filter((_, qIndex) => qIndex !== index)
                setTest((current) => ({ ...current, questions, questionCount: Math.min(current.questionCount, questions.length) }))
              }}>×</button>
            </div>
          ))}
          <button className="add-question" onClick={() => setTest((current) => ({ ...current, questions: [...current.questions, emptyQuestion()] }))}>+ Savol qo‘shish</button>
        </div>
        <div className="modal-footer"><button className="secondary" onClick={onClose}>Bekor qilish</button><button className="primary" disabled={saving} onClick={() => void submit()}>{saving ? 'Saqlanmoqda...' : 'Testni saqlash'}</button></div>
      </div>
    </div>
  )
}

export default App
