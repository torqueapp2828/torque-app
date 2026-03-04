# Torque

A comprehensive vehicle fleet management app for car and motorcycle owners. Track insurance, registration, fuel, service history, parking locations, and more — all encrypted and stored locally on your device.

## Features

- **Vehicle Management** — Add and manage multiple cars and bikes with full details (name, plate, year, fuel type, color)
- **Insurance & Registration Tracking** — Automatic alerts at 90, 30, and 7 days before expiry with push notifications
- **Service & Maintenance Logs** — Record service history with type, odometer reading, and next service interval
- **Fuel Economy Tracking** — Log fill-ups with date, liters, cost, and odometer; view consumption trends
- **GPS Parking** — Tag parking locations with GPS coordinates and navigate via Google Maps
- **Photo Gallery** — Capture and organize vehicle photos with a lightbox viewer
- **Notes & Reminders** — Add custom notes and date-based reminders per vehicle
- **Fleet Dashboard** — Overview stats, urgent issues count, and filter/sort/search across all vehicles
- **Cloud Backup** — Backup and restore via Google Drive

## Security

All data is encrypted with **AES-256-GCM** using PBKDF2 key derivation before being stored in local browser storage. Access is protected by a **PIN** (SHA-256 hashed) with optional **biometric authentication** (fingerprint/face recognition).

## Tech Stack

- **React 19** + **Vite 8** — Frontend framework and build tool
- **Capacitor 8** — Cross-platform native layer for Android
  - `@capacitor/android` — Android compilation
  - `@capacitor-community/biometric-auth` — Fingerprint/Face ID
  - `@capacitor/local-notifications` — Push notifications
  - `@capacitor/google-drive` — Cloud backup
- **Leaflet.js** — Map display for parking locations
- **Web Crypto API** — Client-side AES-256-GCM encryption

## Getting Started

### Prerequisites

- Node.js 18+
- Android Studio (for APK builds)
- Java 17+

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm run dev
```

### Build Android APK

```bash
./build.sh
```

This script builds the web app, syncs to the Android project, and compiles the APK. The output is `torque-latest.apk`.

## Project Structure

```
torque/
├── src/
│   ├── App.jsx              # Main app (~1800 lines — all components)
│   ├── main.jsx             # React entry point
│   └── assets/
│       └── torque-logo.svg
├── android/                 # Capacitor Android project
├── public/                  # Static assets
├── dist/                    # Built web files
├── capacitor.config.json    # Capacitor configuration
├── build.sh                 # APK build automation
├── generate-icons.sh        # App icon generation
└── torque-latest.apk        # Latest Android APK
```

## Data Model

Each vehicle stores:

```js
{
  id, type, name, plate, year, fuel, color,
  parking, gps,
  insurance: { provider, policy, expiry },
  registration: { rc, expiry },
  service: [],        // Service records
  fuelLog: [],        // Fuel fill-up history
  odoLog: [],         // Odometer readings
  reminders: [],      // User reminders
  notes: [],          // Notes
  photos: [],         // Photo gallery
  alerts: [],         // Auto-generated expiry alerts
  parkingHistory: []  // Parking location history
}
```

## License

MIT
