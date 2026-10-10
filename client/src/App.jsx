import { useCallback, useEffect, useState } from 'react'
import AuthPage from './AuthPage.jsx'
import RoomsPage from './RoomsPage.jsx'
import RoomView from './RoomView.jsx'
import Topbar from './Topbar.jsx'
import { api, getToken, setToken } from './api.js'
import { useRoomRoute } from './room.js'

export default function App() {
  const [user, setUser] = useState(undefined) // undefined = checking, null = signed out
  const [serverDown, setServerDown] = useState(false)
  const [roomId, navigate] = useRoomRoute()

  const signOut = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

  useEffect(() => {
    if (!getToken()) return setUser(null)
    api
      .me()
      .then((res) => setUser(res.user))
      .catch((err) => {
        if (err.status === 0) setServerDown(true)
        else signOut() // expired or invalid token
      })
  }, [signOut])

  if (serverDown)
    return (
      <div className="page center">
        <div className="card notice">
          <h2>Cannot reach the server</h2>
          <p className="muted">Start it with <code>npm run dev</code>, then reload this page.</p>
        </div>
      </div>
    )
  if (user === undefined) return <div className="page"><p className="muted">Loading…</p></div>
  if (user === null) return <AuthPage onSignedIn={setUser} />

  return (
    <div className="app">
      <Topbar user={user} onUserChange={setUser} onSignOut={signOut} onHome={() => navigate(null)} />
      {roomId ? (
        <RoomView
          key={roomId}
          roomId={roomId}
          user={user}
          onBack={() => navigate(null)}
          onSignedOut={signOut}
        />
      ) : (
        <RoomsPage user={user} onOpen={navigate} />
      )}
    </div>
  )
}