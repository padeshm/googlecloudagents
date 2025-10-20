// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// Correct Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyAhKkOIljoaUNgUhHfOYasJBssxpQwfYsg",
  authDomain: "mahle-translation-poc.firebaseapp.com",
  projectId: "mahle-translation-poc",
  storageBucket: "mahle-translation-poc.appspot.com",
  messagingSenderId: "652176787350",
  appId: "1:652176787350:web:00a207bdaebbd1efaaffb7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication and get a reference to the service
export const auth = getAuth(app);
