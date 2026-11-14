# SIMOPS Radar API

A small Cloudflare Worker behind the voluntary forms on the site. It stores
alert sign-ups and feedback in a D1 database called `simops-radar`.

- `POST /signup` with `{email, consent: true, operator, watching, settings}`
- `POST /remove` with `{email}` deletes the sign-up and clears that email from feedback
- `POST /feedback` with `{text, email?}`

Only requests from the site's own addresses are accepted, a hidden field
catches simple bots, and each visitor (by hashed IP, kept one day) is limited
to 30 posts a day.

## Seeing the data

Cloudflare dashboard → Storage & databases → D1 → simops-radar → Console:

    SELECT * FROM signups ORDER BY created DESC;
    SELECT * FROM feedback ORDER BY id DESC;

## Setting it up

1. Create the D1 database `simops-radar` and run `schema.sql` in its console.
   (No comments in that file: the console joins lines, so a `--` comment would hide the rest.)
   Columns: signups.settings is the page link with the rules they had set; feedback.email is
   optional; hits.who is a salted hash of the IP, kept one day for rate limiting.
2. Create a Worker `simops-radar-api` with `worker.js`, bind the database as `DB`,
   and add a text variable `SALT` set to any random string.
3. Add the custom domain `api.simopsradar.com` to the Worker.

Local testing: `npx wrangler d1 execute simops-radar --local --file schema.sql`
then `npx wrangler dev --local`.
