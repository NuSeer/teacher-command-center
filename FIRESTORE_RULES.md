# Firestore Security Rules — Private Beta

These rules gate Firestore reads/writes to invite-approved accounts only. **Pasting
the rules alone doesn't do anything by itself — this file is instructions for you,
not something the app reads.** The invite-code UI and claim logic already live in
`index.html` (`authSubmit()` / `claimInviteCode()`); these rules are what makes that
enforcement real instead of just a client-side check anyone could bypass by editing
the page.

## How it works

- `invites/{code}` documents are created **by you only**, directly in the Firebase
  Console (the rules below block all client writes to this collection except the
  one-time "mark used" update a signup performs).
- When someone registers, the app tries to claim their invite code: it creates
  `approvedTesters/{their-uid}` and marks the invite `used: true`. If the code is
  missing, already used, or doesn't match, the claim fails and the app deletes the
  half-created account so there's no way to end up "signed up but unapproved."
- `teachers/{uid}/**` (all your actual app data) now requires **either** an
  `approvedTesters/{uid}` doc to exist, **or** the teacher's data doc to already
  exist — that second clause grandfathers in your own existing account (and anyone
  already using the app before you turn this on) without needing to know every UID
  in advance.

## ⚠️ Do this BEFORE publishing the rules — protect your existing testers

You've already shared the app with people under the old open-signup system, and at
least one of them has already logged in. The grandfather clause below (`exists(.../data/main)`)
only protects someone who has *already saved data at least once* — if any existing
tester signed up but hasn't done enough yet to trigger a save, publishing these rules
would lock them out immediately.

**Don't rely on that — explicitly approve every existing account first:**

1. Firebase Console → your project → **Authentication → Users**. Note the UID next to
   each existing tester's email (and your own account).
2. Firestore Database → **Data** tab → start collection `approvedTesters` → for each
   UID, create a document with **Document ID = that UID** (any fields are fine, e.g.
   `{note: "pre-existing tester"}` — the rules only check that the document exists).
3. Do this for every account currently in Authentication → Users, including yours,
   before you publish the rules in the next section. Once done, none of them can ever
   get locked out by this change, regardless of what data they have saved.

## Steps

1. Firebase Console → your project → **Firestore Database → Rules**.
2. Replace the existing rules with the block below, then **Publish**.
3. To create a test invite code for a NEW tester going forward: Firestore Database →
   **Data** tab → start collection `invites` (if not already there) → Document ID =
   the code itself (e.g. `TESTER-ALPHA-01`) → add one field: `used` (boolean) = `false`.
   Give that code string to the tester.
4. Each code is single-use. Add one document per tester (or per small batch if you
   want a shared code — same idea, just used by whoever gets there first).
5. To revoke someone mid-beta: delete their `approvedTesters/{uid}` document. Their
   existing session keeps working until they reload/re-open the app, then they're
   locked out of their own data (still logged into Firebase Auth, but every read/write
   gets denied).

## Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Existing app data — now requires invite-approval OR pre-existing data (grandfathers
    // in accounts that existed before this gate went live).
    match /teachers/{userId}/{document=**} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId
        && (
          exists(/databases/$(database)/documents/approvedTesters/$(userId))
          || exists(/databases/$(database)/documents/teachers/$(userId)/data/main)
        );
    }

    // Invite codes: you create these manually in the console. Clients can read one
    // (to check it exists/is unused) and can mark exactly their own claim as used —
    // nothing else. No client can create, delete, or re-open a used code.
    match /invites/{code} {
      allow read: if request.auth != null;
      allow update: if request.auth != null
        && resource.data.used == false
        && request.resource.data.used == true
        && request.resource.data.usedBy == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['used','usedBy','usedAt']);
      allow create, delete: if false;
    }

    // Approval records: a user may only ever create their OWN approval doc, and only
    // by referencing an invite code that is (at the moment of the write) still unused.
    // Once created it's permanent from the client side — only you can remove one
    // (via the console) to revoke access.
    match /approvedTesters/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.data.code is string
        && exists(/databases/$(database)/documents/invites/$(request.resource.data.code))
        && get(/databases/$(database)/documents/invites/$(request.resource.data.code)).data.used == false;
      allow update, delete: if false;
    }
  }
}
```

## Note on the small race window

Two people submitting the exact same still-unused code at the *same instant* could
both pass the `used == false` check before either write lands — for a small beta this
is a non-issue (give each tester their own code and it never comes up), but it's not
a cryptographically airtight single-use guarantee under concurrent load.
