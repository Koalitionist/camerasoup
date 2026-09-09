// A join code and an angle name are neither usernames nor passwords, but a
// lone text input sitting next to a button is exactly the shape a password
// manager looks for — so one offers to fill the room code with a login.
//
// autoComplete alone does not settle it: the browser honours it, and each
// manager wants its own opt-out attribute. Setting a plain, non-credential
// `name` matters too, since the heuristics read the name as much as the type.
export const NO_AUTOFILL = {
  type: 'text',
  autoComplete: 'off',
  'data-1p-ignore': 'true', // 1Password
  'data-lpignore': 'true', // LastPass
  'data-bwignore': 'true', // Bitwarden
  'data-form-type': 'other', // Dashlane
} as const;
