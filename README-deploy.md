Vinakaar Backend (SendGrid)

Overview
--------
This backend exposes POST /api/send-pdf which accepts JSON:
  { name, email, phone }
It attaches the configured PDF (backend/assets/<PDF_FILENAME>) and emails it via SendGrid.
It also logs each request to backend/requests.csv.

Setup (local)
-------------
1. Install dependencies:
   cd backend
   npm install

2. Create .env from .env.example and fill values:
   - SENDGRID_API_KEY (get from SendGrid dashboard -> API Keys)
   - FROM_EMAIL (must be a verified sender in SendGrid)
   - PDF_FILENAME (place your PDF in backend/assets/)

3. Place PDF in:
   backend/assets/<PDF_FILENAME>

4. Start server:
   npm run dev   # development (requires nodemon)
   or
   npm start     # production

5. Test endpoint (from your frontend or curl):
   POST http://localhost:3000/api/send-pdf
   body: { "name": "A", "email": "a@example.com", "phone": "123" }

SendGrid setup
--------------
1. Create a SendGrid account (https://sendgrid.com).
2. Verify sender identity:
   - Either verify a single sender email (good for testing) OR
   - Verify your domain (recommended for production)
3. Create an API Key (full access or Mail Send).
4. Paste the API key into SENDGRID_API_KEY in .env.

Notes & Troubleshooting
-----------------------
- If SendGrid returns permission errors, ensure the sender email is verified.
- Check server console logs for errors; SendGrid errors usually include helpful messages.
- requests.csv will be created in backend/ on first submission.
- In production, restrict CORS to your frontend domain.

Security
--------
- Do not commit .env with the API key to version control.
- For higher throughput or analytics, use a real DB instead of CSV.
