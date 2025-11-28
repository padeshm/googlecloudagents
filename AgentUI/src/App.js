
import React, { useState, useRef, useEffect } from 'react';
import {
    User,
    Send,
    Moon,
    Sun,
    Loader,
    LogOut,
} from 'lucide-react';
import { auth } from './firebase';
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";

const ChatbotTemplate = () => {
    const [isDarkMode, setIsDarkMode] = useState(false);
    const [user, setUser] = useState(null);
    const [gcpAccessToken, setGcpAccessToken] = useState(null);
    const [isProfileOpen, setIsProfileOpen] = useState(false);

    const lightModeLogo = 'https://www.wipro.com/content/dam/wipro/social-icons/wipro_new_logo.svg';
    const darkModeLogo = 'https://companieslogo.com/img/orig/WIT.D-91671412.png?t=1739861069';

    const [agents, setAgents] = useState([
        {
            id: 'google-cloud-helper',
            name: 'Google Cloud Storage Agent',
            description: 'I can help you with listing various Google Cloud Storage bucket details in the project you specify',
            messages: [
                { id: 1, type: 'bot', content: "Hello! I am the Google Cloud Storage Agent. You are looking for which project's storage buckets?", timestamp: new Date().toISOString() }
            ],
            endpoint: 'https://mcp-server-backend-652176787350.us-central1.run.app/api/prompt'
        },
        {
            id: 'gcloud-command-executor',
            name: 'Google Cloud Command Executor',
            description: 'I execute gcloud commands directly. I do not understand natural language.',
            messages: [
                { id: 1, type: 'bot', content: "GCloud Command Executor ready. Please provide a `gcloud` command to run (e.g., 'compute instances list').", timestamp: new Date().toISOString() }
            ],
            endpoint: 'https://gcloud-mcp-server-652176787350.us-central1.run.app/api/gcloud'
        }
    ]);

    const [currentAgentId, setCurrentAgentId] = useState('google-cloud-helper');
    const [currentMessage, setCurrentMessage] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const profileRef = useRef(null);
    const messagesEndRef = useRef(null);

    const activeAgent = agents.find(a => a.id === currentAgentId);

     useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [activeAgent?.messages]);


    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            console.log("Firebase Auth state changed. User:", user);
            setUser(user);
            if (!user) {
                setGcpAccessToken(null);
            }
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (profileRef.current && !profileRef.current.contains(event.target)) {
                setIsProfileOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);


    const handleSignIn = async () => {
        const provider = new GoogleAuthProvider();
        provider.addScope('https://www.googleapis.com/auth/cloud-platform');
        provider.setCustomParameters({ prompt: 'select_account' });

        try {
            const result = await signInWithPopup(auth, provider);
            const credential = GoogleAuthProvider.credentialFromResult(result);
            if (credential) {
                const token = credential.accessToken;
                console.log("Successfully got GCP Access Token:", token);
                setGcpAccessToken(token);
            } else {
                 console.error("Could not get credential from sign-in result.");
                 setGcpAccessToken(null);
            }
        } catch (error) {
            console.error("Error during sign-in:", error);
            setGcpAccessToken(null);
        }
    };

    const handleSignOut = () => {
        signOut(auth).then(() => {
            setUser(null);
            setGcpAccessToken(null);
            setIsProfileOpen(false);
            console.log("User signed out successfully.");
        }).catch((error) => {
            console.error("Sign-out error:", error);
        });
    };

    const handleSendMessage = async () => {
        if (!activeAgent || currentMessage.trim() === '' || !user || !gcpAccessToken) {
            if (!gcpAccessToken) alert("GCP Access Token is missing. Please sign in again.");
            return;
        }

        const userMessage = {
            id: Date.now(),
            type: 'user',
            content: currentMessage,
            timestamp: new Date().toISOString()
        };

        const currentHistoryWithUserMessage = [...activeAgent.messages, userMessage];

        setAgents(prevAgents => prevAgents.map(agent =>
            agent.id === currentAgentId ? { ...agent, messages: currentHistoryWithUserMessage } : agent
        ));

        setIsLoading(true);
        const messageToSend = currentMessage;
        setCurrentMessage('');

        try {
            const isCommandExecutor = activeAgent.id === 'gcloud-command-executor';

            const requestBody = isCommandExecutor
                ? { command: messageToSend }
                : { prompt: messageToSend, history: activeAgent.messages };

            const response = await fetch(activeAgent.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${gcpAccessToken}`
                },
                body: JSON.stringify(requestBody),
            });

            const data = await response.json();

            if (!response.ok) {
                 // Use the error message from the backend response if available
                throw new Error(data.response || data.error || `HTTP error! status: ${response.status}`);
            }

            if (isCommandExecutor) {
                const botMessage = {
                    id: Date.now() + 1,
                    type: 'bot',
                    content: data.response,
                    timestamp: new Date().toISOString(),
                };
                 setAgents(prevAgents => prevAgents.map(agent =>
                    agent.id === currentAgentId ? { ...agent, messages: [...currentHistoryWithUserMessage, botMessage] } : agent
                ));

            } else {
                // For conversational agent, the backend returns the whole history
                setAgents(prevAgents => prevAgents.map(agent =>
                    agent.id === currentAgentId ? { ...agent, messages: data.history } : agent
                ));
            }

        } catch (error) {
            console.error("--- Error in handleSendMessage ---", error);
            const errorResponse = {
                id: Date.now() + 1,
                type: 'bot',
                content: `Sorry, I encountered an error: ${error.message}`,
                timestamp: new Date().toISOString(),
            };
            setAgents(prevAgents => prevAgents.map(agent =>
                agent.id === currentAgentId ? { ...agent, messages: [...currentHistoryWithUserMessage, errorResponse] } : agent
            ));
        } finally {
            setIsLoading(false);
        }
    };

    const toggleDarkMode = () => {
        setIsDarkMode(!isDarkMode);
    };

    const themeClass = isDarkMode ? 'dark bg-gray-900' : 'bg-gray-50';
    const cardClass = isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
    const textClass = isDarkMode ? 'text-gray-100' : 'text-gray-900';
    const textSecondaryClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
    const inputClass = isDarkMode ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500';
    const hoverClass = isDarkMode ? 'hover:bg-gray-700/70' : 'hover:bg-gray-100';

    const agentMessages = activeAgent ? activeAgent.messages : [];

    if (!user) {
        return (
            <div className={`min-h-screen transition-colors duration-300 ${themeClass} flex items-center justify-center`}>
                <div className="text-center">
                    <h1 className={`text-3xl font-bold mb-6 ${textClass}`}>Welcome to Google Cloud Agents</h1>
                    <button
                        onClick={handleSignIn}
                        className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                    >
                        Sign in with Google
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={`min-h-screen transition-colors duration-300 ${themeClass} flex flex-col h-screen`}>
            {/* Header */}
            <header className={`${cardClass} border-b px-6 py-4 transition-colors duration-300 shadow-lg z-20 flex-shrink-0`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-6">
                         <div className="flex items-center space-x-3">
                            <img
                                src={isDarkMode ? darkModeLogo : lightModeLogo}
                                alt="Company Logo"
                                className="h-10 w-auto object-contain transition-opacity duration-300"
                            />
                            <div>
                                <h1 className={`text-xl font-bold ${textClass}`}>Google Cloud Agents </h1>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center space-x-4">
                         <button
                            onClick={toggleDarkMode}
                            className={`p-2 rounded-lg transition-colors ${
                                isDarkMode ? 'hover:bg-gray-700 text-gray-300' : 'hover:bg-gray-100 text-gray-600'
                            }`}
                        >
                            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                        </button>

                        <div className="relative" ref={profileRef}>
                            <button onClick={() => setIsProfileOpen(!isProfileOpen)} className="w-10 h-10 rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                                {user.photoURL ? (
                                    <img src={user.photoURL} alt="Profile" className="w-full h-full rounded-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-blue-600 rounded-full flex items-center justify-center">
                                        <User className="w-5 h-5 text-white" />
                                    </div>
                                )}
                            </button>
                            {isProfileOpen && (
                                <div className={`absolute right-0 mt-2 w-64 ${cardClass} border rounded-xl shadow-2xl py-2 z-50 animate-fade-in`}>
                                    <div className={`flex items-center px-4 py-3 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                                        <img src={user.photoURL} alt="Profile" className="w-10 h-10 rounded-full object-cover mr-3" />
                                        <div className="min-w-0">
                                            <p className={`font-semibold truncate ${textClass}`}>{user.displayName || 'User'}</p>
                                            <p className={`text-sm truncate ${textSecondaryClass}`}>{user.email}</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={handleSignOut}
                                        className={`w-full text-left flex items-center px-4 py-3 text-sm transition-colors ${textSecondaryClass} ${hoverClass}`}
                                    >
                                        <LogOut className="w-4 h-4 mr-3" />
                                        Sign Out
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-1 overflow-hidden p-6">
                 <div className="h-full flex rounded-xl overflow-hidden shadow-2xl">
                    {/* Chat Sidebar */}
                    <div className={`w-80 flex-shrink-0 ${cardClass} border-r ${isDarkMode ? 'border-gray-700' : 'border-gray-200'} flex flex-col h-full`}>
                        <div className={`p-4 border-b flex-shrink-0 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                            <div className="mb-4">
                                <h3 className={`font-semibold text-xl ${textClass}`}>Agents</h3>
                            </div>
                        </div>
                        <div className="overflow-y-auto flex-1 custom-scrollbar">
                            {agents.map((agent) => (
                                <div
                                    key={agent.id}
                                    onClick={() => setCurrentAgentId(agent.id)}
                                    className={`p-4 border-b cursor-pointer transition-all duration-200 flex items-start group ${
                                        isDarkMode ? 'border-gray-700 hover:bg-gray-700/50' : 'border-gray-200 hover:bg-gray-100'
                                    } ${
                                        currentAgentId === agent.id
                                            ? isDarkMode ? 'bg-gray-700 shadow-inner' : 'bg-blue-50/70'
                                            : ''
                                    }`}
                                >
                                    <div className="flex-1 min-w-0">
                                        <h4 className={`font-medium truncate ${currentAgentId === agent.id ? 'text-blue-500' : textClass}`}>{agent.name}</h4>
                                        <p className={`text-sm ${textSecondaryClass} truncate`}>{agent.description}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Chat Interface */}
                    <div className={`flex-1 ${cardClass} flex flex-col h-full`}>
                        <div className={`flex items-center p-4 border-b flex-shrink-0 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                            <h2 className={`text-lg font-semibold ${textClass}`}>
                                {activeAgent?.name || 'Select an Agent'}
                            </h2>
                        </div>
                        {/* Chat Messages */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                            {agentMessages.map((message) => (
                                message && message.id && (
                                <div
                                    key={message.id}
                                    className={`flex transition-all duration-300 ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-3xl p-4 rounded-xl shadow-lg animate-fade-in ${
                                        message.type === 'user'
                                            ? 'bg-blue-600 text-white rounded-br-none'
                                            : isDarkMode ? 'bg-gray-700 text-gray-100 rounded-tl-none border border-gray-600' : 'bg-white text-gray-900 rounded-tl-none border border-gray-200 shadow-md'
                                    }`}>
                                        <div className={`leading-relaxed whitespace-pre-wrap ${message.type === 'user' ? 'text-white' : textClass}`}>
                                            {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
                                        </div>
                                    </div>
                                </div>
                                )
                            ))}
                             <div ref={messagesEndRef} />

                            {isLoading && (
                                <div className="flex justify-start">
                                    <div className={`max-w-2xl p-4 rounded-xl shadow-md rounded-tl-none border animate-pulse-fade ${isDarkMode ? 'bg-gray-700 text-gray-100 border-gray-600' : 'bg-white text-gray-900 border-gray-200'}`}>
                                        <div className="flex items-center space-x-2">
                                            <Loader className="w-5 h-5 animate-spin text-blue-600" />
                                            <span className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-500'}`}>
                                                Agent is processing...
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Message Input Area */}
                        <div className={`p-6 border-t flex-shrink-0 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
                            <div className="flex items-center space-x-3">
                                <input
                                    type="text"
                                    value={currentMessage}
                                    onChange={(e) => setCurrentMessage(e.target.value)}
                                    onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                                    placeholder={activeAgent.id === 'gcloud-command-executor' ? 'Enter a gcloud command...' : 'Ask something...'}
                                    className={`flex-1 px-5 py-3 border rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500/50 focus:border-blue-500 transition-all duration-300 ${inputClass}`}
                                    disabled={isLoading}
                                />
                                <button
                                    onClick={handleSendMessage}
                                    className={`p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all duration-200 transform hover:scale-[1.05] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none`}
                                    disabled={!currentMessage.trim() || isLoading}
                                >
                                    {isLoading ? <Loader className="w-6 h-6 animate-spin" /> : <Send className="w-6 h-6" />}
                                </button>
                            </div>
                             <div className="flex items-center justify-center mt-3">
                                <p className={`text-xs ${textSecondaryClass}`}>
                                 Wipro 2025
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
};

export default ChatbotTemplate;
