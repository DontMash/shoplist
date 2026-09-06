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
