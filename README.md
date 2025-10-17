# Google Cloud Agent UI & Services

This project contains the front-end UI and backend agent services for a comprehensive Google Cloud-native solution.

-   **UI (`/AgentUI`)**: A React-based single-page application that provides the user interface for interacting with the backend agents.
-   **Backend (Agents)**: A collection of server-side services (to be developed) that will be deployed as individual containers on Google Cloud Run.

---

## 1. First-Time Setup & Deployment

Follow these steps to configure the project and deploy the UI to Firebase Hosting for the first time. This process sets up a CI/CD pipeline using GitHub Actions, which automatically deploys the UI whenever you push changes to the `main` branch.

### Prerequisites

-   A Google Cloud Project with the Firebase service enabled.
-   A GitHub repository for this project.
-   [Node.js and npm](https://nodejs.org/en/) installed locally.
-   [Firebase CLI](https://firebase.google.com/docs/cli) installed locally (`npm install -g firebase-tools`).

### Steps

1.  **Log in to Firebase:**
    ```bash
    firebase login
    ```
    This will open a browser window to authenticate with your Google account.

2.  **Initialize Firebase Hosting:**
    Run this command from the project's root directory:
    ```bash
    firebase init hosting:github
    ```

3.  **Answer the CLI Prompts:**
    -   **Project:** Select `Use an existing project` and choose your Google Cloud project.
    -   **Public Directory:** Enter `AgentUI/build`. This is the output folder for the React production build.
    -   **Single-Page App:** Answer `y` (Yes). This is crucial for client-side routing in React.
    -   **Automatic Deploys with GitHub:** Answer `y` (Yes).
    -   **Repository:** Enter your GitHub repository name in the format `username/repository-name`.
    -   **Build Script:** Enter `cd AgentUI && npm install && npm run build`. This tells the deployment script how to build the UI.
    -   **Merge Workflow:** Answer `y` (Yes) to create the GitHub Actions workflow file.

4.  **Push to GitHub to Deploy:**
    Commit the new configuration files and push them to your repository. This will trigger the first automatic deployment.
    ```bash
    git add .firebaserc firebase.json .github/ README.md
    git commit -m "Initial setup of Firebase Hosting and CI/CD"
    git push origin main
    ```

5.  **Verify:**
    Go to the "Actions" tab in your GitHub repository to watch the deployment run. Once complete, find your live URL in the Firebase Console under the "Hosting" section.

---

## 2. Developing and Deploying Future Changes

Once the initial setup is complete, making updates to the live UI is simple.

1.  **Develop Locally:** Make all code changes within the `/AgentUI` directory. Test your changes using the local development server:
    ```bash
    cd AgentUI
    npm start
    ```

2.  **Commit and Push:**
    When you are ready to deploy your changes, commit them to Git and push them to the `main` branch.
    ```bash
    # From the project root directory
    git add .
    git commit -m "Your descriptive commit message"
    git push origin main
    ```

The push will automatically trigger the GitHub Action, and your updated UI will be live in a few minutes.
