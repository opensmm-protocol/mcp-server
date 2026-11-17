# MCP Registry: no entry

OpenSMM is not listed in the official MCP Registry: `GET
https://registry.modelcontextprotocol.io/v0/servers?search=opensmm` answers
`{"servers":[],"metadata":{"count":0}}`, and that is the expected result.

Schema `2025-12-11` accepts a server only with a published package (`packages[]`
carrying `registryType` and `identifier`) or with `remotes` pointing at a public
hosted endpoint. OpenSMM has neither: no package is published, the container
image stays private, and there is no public remote MCP endpoint. Inventing
`packages` or `remotes` is not allowed.

What would change this: a published package or a public hosted MCP endpoint.
Until then the node is installed from source — see
[Run a node from source in 5 minutes](../README.md#run-a-node-from-source-in-5-minutes).
