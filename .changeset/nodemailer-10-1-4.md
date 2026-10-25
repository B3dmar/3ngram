---
'@3ngram/server': patch
---

Security: nodemailer 10.1.4 (GHSA-85x2-q946-cp5h). Its address parser ended an angle-addr at the first `>` even inside a quoted local part, so a value like `<"a@evil.com>"@good.com>` could be delivered to a domain the header does not name. The server's mailer passes recipient strings straight to nodemailer (password reset, email verification, and `sendTransactionalEmail`, which a private surface reuses for its own notifications), so the fix applies. No API or behaviour change.
