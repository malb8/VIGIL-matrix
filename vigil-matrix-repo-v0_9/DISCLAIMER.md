# Disclaimer

VIGIL Matrix is an **experimental research preview**, provided "as is",
without warranty of any kind (see the Apache-2.0 license, sections 7 and 8).

In particular, VIGIL Matrix does **not** guarantee:

- that all trackers, advertisements, fingerprinting scripts, beacons or
  malicious resources are blocked;
- that cookies are always stripped (documented edge cases exist, e.g. draft
  removal of a committed cookie rule applies only after Save);
- that any website's tracking, profiling or data collection is prevented —
  server-side and first-party techniques are outside what any request-level
  tool can control;
- protection against phishing, malware, exploits or data breaches;
- compatibility of any website with your policy: blocking resources **will**
  break sites, and default-deny mode breaks most sites until configured.

VIGIL Matrix operates within the constraints of Chromium's Manifest V3:

- enforcement is performed by the browser's declarativeNetRequest engine
  based on rules VIGIL compiles; VIGIL cannot observe or veto individual
  requests in flight;
- requests the browser does not route through DNR, or that occur before
  rules are registered, are not affected;
- diagnostic information (matched rules) is rate-limited by the browser and
  is a best-effort reconstruction, not a complete log.

This project is a tool for **inspection and policy experimentation by
advanced users**. It is not a substitute for browser security updates,
endpoint protection, or good judgment. You are responsible for the policies
you deploy and for verifying that they do what you intend.

Nothing in this repository is legal, compliance or security advice.
