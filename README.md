# FormForge — Beautiful Forms, Zero Backend

A privacy-first form builder. Create professional forms, fill them out, validate
responses, and export results. Everything works locally in the browser, with no
accounts, servers, or external APIs. After the first load, a service worker
caches the app shell (index.html, style.css, app.js) so the site keeps working
with network access disabled; the Google Fonts stylesheet is optional and its
failure falls back to system fonts.

## Views

- **Dashboard** — list saved forms, create, duplicate, rename, delete, and search.
- **Builder** — add fields, reorder them (drag, or Move up / Move down buttons),
  edit settings, and see a live preview in desktop or mobile width.
- **Fill form** — a polished, validated form. Responses are saved only on this device.
- **Responses** — search responses, inspect individual submissions, delete entries,
  and export CSV.

## Field types

Short text, email, number, date, dropdown, radio buttons, checkboxes, long answer.

## Field settings

Required / optional, placeholder, description, choices (one per line),
minimum / maximum length for text, minimum / maximum value for numbers, and
conditional logic: show a field only when a previous dropdown or radio answer
matches a chosen value. Hidden fields are not validated and are not stored.

## Storage and backup

Forms and responses live in IndexedDB in this browser. Use **Export backup** to
download the whole workspace as JSON, and **Import backup** to restore it.
Import is validated first and replaced in a single transaction: a corrupt file,
an unsupported version, a duplicate field id, or a malformed history of rules
leaves your existing data untouched.

## Standalone forms

From the builder, **Download standalone form** saves one form as a single HTML
file. Send that file to someone and they can complete it on their own device
and export their answers as JSON or CSV. It never sends anything to a server,
and it does not collect responses centrally — shared links must not pretend
otherwise.

## Run locally

Open `index.html` in a browser, or serve the folder with any static server, for
example `python3 -m http.server 8000`, then open http://localhost:8000/.

## Manual test checklist

1. Create a form, add one field of every type, and reorder with drag and with
   the Move up / Move down buttons.
2. Set a field required, an email field, a number field with min / max, and a
   text field with min / max length. Submit the form empty and with invalid
   values, and confirm each error appears next to its field.
3. Add a dropdown, then a second field shown only when one dropdown answer is
   chosen. Fill the form with the other answer and confirm the second field
   stays hidden and is not required. Conditional sources are earlier
   dropdown/radio fields only; reordering a field above its source removes
   the rule, and hiding a middle link in a chain hides everything below it,
   with no hidden answers stored.
4. Submit a valid response, reload the page, and confirm the form and the
   response are still there.
5. In Responses, search for a word from an answer, delete one response, and
   export CSV. Open the CSV and confirm a value containing a comma and a quote
   is quoted correctly.
6. Export a backup, delete everything, import the backup, and confirm the
   forms and responses return. Import a corrupt JSON file and a backup with
   version 2, and confirm both are rejected with your data unchanged.
7. Download the standalone form, open it, complete it, and export its answers.
   Try exporting with an invalid answer first and confirm the export is
   blocked until the errors are fixed. Radio and checkbox questions use a
   fieldset with a legend in both the main app and the standalone form.
8. Resize to 320 px wide and confirm there is no horizontal scrolling and no
   inaccessible controls, and tab through the builder and the fill view to
   confirm visible focus, keyboard-operable reordering (Move up / Move down),
   and field errors announced via the alert role.
9. Switch between light and dark mode and confirm text stays readable.
10. After the first load, disable network access and reload: the site, its
    forms, and its responses must still work from the service-worker cache
    and IndexedDB, with system fonts in place of Google Fonts.
