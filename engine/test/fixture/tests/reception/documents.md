# Reception: documents

## Test: Upload paperwork and open it in the PDF viewer
id: upload-paperwork-and-open-it-in-the-pdf-viewer
Note: "Upload Files" is a focusable card over a hidden file input (a basic upload control); the viewer draws the
PDF on a canvas under a transparent text layer, as pdf.js does.
1. open "/upload.html"
2. upload "files/referral.pdf" to the "Upload Files" card under "Additional Paperwork"
3. expect "Additional Paperwork" has a document card "referral.pdf"
4. click the "visibility" icon of the "referral.pdf" card
5. expect the PDF viewer shows "INTENT-UPLOAD-7f3a" within 5 seconds

## Test: Upload through a file field and through a button
id: upload-through-a-file-field-and-through-a-button
1. open "/upload.html"
2. upload "files/photo.png" to the "Referral letter" file field
3. expect the page shows "Referral letter: photo.png"
4. upload "files/referral.pdf" to the "Attach photo" button
5. expect the page shows "Photo: referral.pdf"

## Test: An upload to a button that opens no file picker fails
id: an-upload-to-a-button-that-opens-no-file-picker-fails
tags: @expect-fail
Note: "Clear received" opens no file picker, so step 2 must FAIL.
1. open "/upload.html"
2. upload "files/referral.pdf" to the "Clear received" button
