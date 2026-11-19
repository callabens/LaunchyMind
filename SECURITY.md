# Security

LaunchyMind runs on your machine. It reads the project you point it at and, unless you pass `--offline`, fetches the public `http` and `https` URLs that project names.

It does not send telemetry. It does not log into Apple, Google, or any other account. URLs with a username or password are not fetched.

Rule packs are parsed as data and validated before use. They are not loaded as JavaScript.

If you find a vulnerability, open a GitHub issue or contact the maintainers through the repository. Please include a fixture that shows the problem and avoid posting secrets from a real app.
