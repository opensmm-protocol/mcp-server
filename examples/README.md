# Examples

Copyable reference files. Nothing here is imported by the node or executed by
`npm ci`; every file is meant to be read, copied and edited.

## `provider-profile.example.json`

A `RegisterProviderRequest` for the `rest-v1` dialect — the payload you send to
`POST /v0/providers` on your node. It is the file behind «Copy this profile» in
[`docs/PROVIDER_ONBOARDING.md`](../docs/PROVIDER_ONBOARDING.md).

Placeholders only:

- `endpoint` — the panel's base URL (its v1 API root). The adapter appends
  `/services`, `/orders` and `/orders/:id`, so give it the same prefix those
  paths hang off, e.g. `https://panel.example/api/v1`.
- `apiKey` — the panel credential, sent as `Authorization: Bearer`. The gateway
  never returns it, never logs it and never publishes it.
- `profile` is not set: profiles describe `smm-v2` panel deviations. A
  `rest-v1` panel needs `endpoint` + `apiKey` and nothing else.

The sample contains no real panel URL and no real key, and `npm test` keeps it
that way: it is validated against
`spec/v0/schemas/register-provider-request.json` and asserted to use a
`.example` host and a placeholder key. Fill a copy **outside** this repository —
the filled file is a secret.
