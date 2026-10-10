import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { yCollab } from 'y-codemirror.next'
import { oneDark } from '@codemirror/theme-one-dark'
import { PALETTE } from './identity.js'
import { WS_URL } from './api.js'

/**
 * The shared code editor. The server decides whether you may type (this
 * `readOnly` flag is only the matching UI: the server drops viewer edits anyway).
 * The parent remounts this component (via `key`) when your role changes.
 */
export default function Editor({ room, token, identity, readOnly, onStatus, onUsers, onClose }) {
  const hostRef = useRef(null)
  const colorRef = useRef(identity.color)
    const nameRef = useRef(identity.name)
  const publishRef = useRef(null)
  const callbacks = useRef({})
  callbacks.current = { onStatus, onUsers, onClose }
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(WS_URL, room, doc, { params: { token } })
    const ytext = doc.getText('code')
    const awareness = provider.awareness

    // Tell everyone in the room who we are (name + cursor colour).
    const publishUser = () => {
      const color = colorRef.current
      awareness.setLocalStateField('user', { name:nameRef.current, color, colorLight: color + '33' })
    }
    publishRef.current = publishUser
    publishUser()

    provider.on('sync', (isSynced) => isSynced && setReady(true))
    provider.on('status', ({ status }) => callbacks.current.onStatus(status))
    provider.on('connection-close', (event) => callbacks.current.onClose?.(event?.code ?? 0))

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
      callbacks.current.onUsers(users)
    }
    awareness.on('change', pushUsers)
    pushUsers()

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          oneDark,
          javascript(),
          yCollab(ytext, awareness),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [])
        ]
      })
    })

    return () => {
      awareness.off('change', pushUsers)
      view.destroy()
      provider.destroy()
      doc.destroy()
    }
    // room, token and readOnly never change for a mounted editor (the parent remounts it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, token, readOnly])
  // Renaming yourself updates your cursor label for everyone, without reconnecting.
  useEffect(() => {
    nameRef.current = identity.name
    publishRef.current?.()
  }, [identity.name])
  return (
    <div className="editor-wrap">
      {!ready && <div className="loading">Connecting to room…</div>}
      <div ref={hostRef} className="editor" />
    </div>
  )
}