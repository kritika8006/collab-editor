// Who may do what in a room. Pure functions, no I/O, so they are easy to test.
//
//   owner   created the room: everything, including sharing and deleting
//   editor  can read and type
//   viewer  can read and see cursors, but cannot change the document
//
// A room also has a `linkRole`: what a signed-in person who merely has the
// link gets. null (default) = nobody without an invitation.

export const MEMBER_ROLES = ['viewer', 'editor']
export const LINK_ROLES = [null, 'viewer', 'editor']

const RANK = { viewer: 1, editor: 2, owner: 3 }
const rank = (role) => RANK[role] ?? 0

/** The role this user has in this room, or null for no access. Highest wins. */
export function roleFor(room, userId) {
  if (!room || !userId) return null
  if (room.ownerId === userId) return 'owner'
  const member = (room.members ?? []).find((m) => m.userId === userId)
  const direct = member ? member.role : null
  const viaLink = room.linkRole ?? null
  return rank(direct) >= rank(viaLink) ? direct : viaLink
}

const NEEDED = { read: 1, write: 2, manage: 3 }

/** can('editor', 'write') -> true.  Unknown actions are always refused. */
export function can(role, action) {
  const needed = NEEDED[action]
  return needed !== undefined && rank(role) >= needed
}