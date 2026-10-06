import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { yCollab } from 'y-codemirror.next'
import { oneDark } from '@codemirror/theme-one-dark'
import { PALETTE } from './identity.js'

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:1234`

const STARTER = `// Welcome! Everyone in this room edits this file live.
function greet(name) {
  return "Hello, " + name + "!";
}

console.log(greet("world"));
`

export default function Editor({ room, identity, onStatus, onUsers }) {
  const hostRef = useRef(null)
  const providerRef = useRef(null)
  const nameRef = useRef(identity.name)
  const colorRef = useRef(identity.color)
  const [ready, setReady] = useState(false)

  // Tell everyone in the room who we are (name + cursor colour).
  const publishUser = () => {
    const provider = providerRef.current
    if (!provider) return
    const color = colorRef.current
    provider.awareness.setLocalStateField('user', {
      name: nameRef.current,
      color,
      colorLight: color + '33'
    })
  }

  // Create the shared document, the connection and the editor.
  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(WS_URL, room, doc)
    providerRef.current = provider
    const ytext = doc.getText('code')
    const awareness = provider.awareness
    publishUser()

    // Seed the starter text once, only if the room is truly empty after sync.
    const onSync = (isSynced) => {
      if (isSynced && ytext.length === 0) ytext.insert(0, STARTER)
      if (isSynced) setReady(true)
    }
    provider.on('sync', onSync)
    provider.on('status', ({ status }) => onStatus(status))

    const pushUsers = () => {
      // If someone who joined before us already uses our colour, pick a free one.
      const othersColors = new Set()
      let clash = false
      awareness.getStates().forEach((state, id) => {
        if (id === awareness.clientID || !state.user) return
        othersColors.add(state.user.color)
        if (id < awareness.clientID && state.user.color === colorRef.current) clash = true
      })
      if (clash) {
        const free = PALETTE.find((c) => !othersColors.has(c))
        if (free) {
          colorRef.current = free
          publishUser() // fires 'change' again, which lands back here
          return
        }
      }
      const users = []
      awareness.getStates().forEach((state, clientId) => {
        if (state.user) users.push({ clientId, isMe: clientId === awareness.clientID, ...state.user })
      })
      users.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.clientId - b.clientId)
      onUsers(users)
    }
    awareness.on('change', pushUsers)
    pushUsers()

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [basicSetup, oneDark, javascript(), yCollab(ytext, awareness)]
      })
    })

    return () => {
      awareness.off('change', pushUsers)
      view.destroy()
      provider.destroy()
      doc.destroy()
      providerRef.current = null
    }
    // room never changes during a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  // Changing your display name updates your cursor label for everyone.
  useEffect(() => {
    nameRef.current = identity.name
    publishUser()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.name])

  return (
    <div className="editor-wrap">
      {!ready && <div className="loading">Connecting to room…</div>}
      <div ref={hostRef} className="editor" />
    </div>
  )
}