# Teacher Command Center

A comprehensive classroom management tool for teachers — built as a single HTML file with Firebase backend for cloud sync.

## Features
- 📊 Gradebook, Missing Work, Behavior Log
- 👩‍🎓 Student Management, Seating Charts, Attendance  
- 📅 Daily Planner, Lesson Plans, Sub Plans
- 💬 Parent Communication Log
- 🖨️ 12 Printable Reports
- 🔗 Curriculum Resources linked to Lesson Plans
- ☁️ Cloud sync via Firebase — works on any device

## Setup

### Prerequisites
- Firebase project with Firestore and Google Auth enabled
- Vercel account (or any static host)
- GitHub account

### Deploy to Vercel
1. Push this repo to GitHub
2. Go to vercel.com → New Project → Import your GitHub repo
3. Vercel auto-detects it as a static site — click Deploy
4. Done — your app is live at `yourproject.vercel.app`

### Firebase Setup
Firebase config is already embedded in `index.html`.  
Firestore security rules (set in Firebase Console → Firestore → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /teachers/{userId}/{document=**} {
      allow read, write: if request.auth != null 
        && request.auth.uid == userId;
    }
  }
}
```

## Usage
1. Sign in with your **personal Gmail** account
2. Go to ⚙️ Schedule Setup → enter your school info and periods
3. Add students in Student Info
4. Explore — sample data is pre-loaded for new accounts

## Data & Privacy
- Each teacher's data is stored privately in Firebase under their Google UID
- No teacher can see another teacher's data
- Export your data anytime from Schedule Setup → ⬇️ Export / Backup
- For year-end: Schedule Setup → 🔄 New Year Reset

## Tech Stack
- Vanilla HTML/CSS/JavaScript (no build step)
- Firebase Auth (Google Sign-In)
- Firebase Firestore (cloud database)
- Vercel (hosting)
- GitHub (version control)
