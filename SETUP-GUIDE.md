# 300 Recipes: getting it onto your phone

There are two ways to turn this folder into an installable app (an APK).
**Option A is recommended**: GitHub's computers build it for you, so you
don't install anything on your laptop.

---

## Option A: Build in the cloud with GitHub (nothing to install)

You only need a free GitHub account and a web browser.

### One-time setup (about 10 minutes)

1. Make a free account at **https://github.com** (the official site).
2. Click the **+** at the top right → **New repository**.
   - Name: `300-recipes`
   - Choose **Private** (only you can see it).
   - Click **Create repository**.
3. On the next page, click the link **"uploading an existing file"**.
4. Unzip `300-recipes.zip` on your laptop. Open the `300-recipes` folder,
   select **everything inside it** (including the `.github` folder), and drag
   it all onto the GitHub upload page. Click **Commit changes**.

   > If the `.github` folder didn't upload, add it by hand: click
   > **Add file → Create new file**, type the name
   > `.github/workflows/build-apk.yml`, open that file from the folder in
   > Notepad, copy everything, paste it into GitHub, and click
   > **Commit changes**.

### Getting the APK (every time)

1. In your repository on GitHub, click the **Actions** tab.
2. You'll see a run called **Build APK** (it starts automatically after every
   upload). Wait for the green check mark, about 5–10 minutes.
   If it hasn't started, click **Build APK** on the left, then **Run workflow**.
3. Click the finished run. At the bottom under **Artifacts**, click
   **300Recipes-apk** to download it. Unzip it to get **`300Recipes.apk`**.

If a run shows a red ✗ instead, click it, open the step with the ✗, and
copy the error text to Claude. It's usually a one-line fix.

### Updating the app later

Upload the changed files to the same repository (Add file → Upload files;
uploading a file with the same name replaces it). A new APK is built
automatically. Install it over the old app; your recipes stay.

---

## Install it on your phone

Try it on your **spare phone first**.

1. Get `300Recipes.apk` onto the phone: Google Drive, email it to yourself,
   or a USB cable to the Downloads folder.
2. Tap the file. Android asks to allow installing from that app (Drive,
   Files, Gmail…). Allow it, go back, and tap **Install**.
3. Google Play Protect may say it doesn't recognize the app, because you
   built it yourself rather than downloading it from the Play Store. Choose
   **Install anyway**.
4. The first time a timer starts, allow notifications so timers can alert
   you while the phone is locked.

Friends and family install the same APK the same way. Each phone keeps its
own recipes.

**About the `signing` folder:** it holds the app's signature. Every APK
built from this project has the same signature, which is what lets a new
version install over the old one without losing recipes. Keep the repository
private, and don't delete that folder.

---

## Backups and new phones

In the app: **Settings → Save a backup** opens the share menu. Save it to
Google Drive. On a new phone: install the APK, then
**Settings → Restore from backup** and pick that file.

---

## Option B: Build on your own PC (optional)

Only if you'd rather not use GitHub. This installs about 10 GB of official
tools.

1. Install **Node.js** (the LTS version) from **https://nodejs.org**.
2. Install **Android Studio** from **https://developer.android.com/studio**.
   Open it once and finish the setup wizard ("Standard").
3. Open the `300-recipes` folder in File Explorer, click the address bar,
   type `cmd`, press Enter, and run:

   ```
   npm install
   npx cap add android
   npm run icons
   ```

4. Double-click **`build-apk.bat`**. When it says Done, `300Recipes.apk` is
   in the folder.

---

## What's where (if you want to tweak things)

| File | What it controls |
| --- | --- |
| `www/css/style.css` | Colors, fonts, spacing. The palette is at the top, for light and dark mode. |
| `www/js/app.js` | All the screens |
| `www/js/parser.js` | Scaling, unit conversion, timer detection, website import |
| `www/js/timers.js` | Step timers |
| `assets/` | App icon and splash screen |
| `.github/workflows/build-apk.yml` | The cloud build |
