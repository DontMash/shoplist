# Shoplist Context

Shoplist coordinates shared, invite-only shopping lists that people can join from an invite link without an account.

## Language

**List session**:
The period in which one device participates in one shopping list, from joining until leaving or losing access. It includes the participant's current view of the list and the ability to exchange list changes.
_Avoid_: client session, socket connection

**Participant**:
A person represented in a list by a stable device identity and a mutable display name. A participant can join an invite-only list without an account.
_Avoid_: user, account

**Item editor**:
The participant whose accepted mutation is most recent for an item. Creating an item establishes its creator as its first editor; an item without a resolvable editor has no attribution badge.
_Avoid_: item owner, author

**List membership**:
A participant's ongoing participation in a list, from a successful join until explicitly leaving or losing access. It is distinct from a list session, which may end and reconnect without changing membership.
_Avoid_: presence, connection

**List activity notification**:
A brief push alert about an accepted list mutation or a participant joining, intended to bring an unavailable participant back to the list rather than serve as a history of changes.
_Avoid_: audit log, activity history

**Push destination**:
A browser installation explicitly authorized by a participant to receive list activity notifications for a list.
_Avoid_: user account, device account
