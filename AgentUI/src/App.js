import React, { useState, useRef } from 'react';
import {
    User,
    Plus,
    MessageCircle,
    Send,
    Paperclip,
    X,
    Moon,
    Sun,
    Shield,
    Activity,
    Calendar,
    Loader,
    Server,
    TrendingUp,
    Users,
    Layers,
    Zap
} from 'lucide-react';

// --- Dummy Agent Data ---
const dummyAgents = [
    { 
        id: 1, 
        name: 'ITSM Resolver', 
        description: 'Automates incident resolution and ticket updates.', 
        icon: Activity, 
        color: 'text-red-500', 
        status: 'Active', 
        stats: '124 Auto-Resolves' 
    },
    { 
        id: 2, 
        name: 'Change Manager Bot', 
        description: 'Reviews and approves standard change requests automatically.', 
        icon: Calendar, 
        color: 'text-purple-500', 
        status: 'Active', 
        stats: '45 Changes Managed' 
    },
    { 
        id: 3, 
        name: 'Data Analyst Agent', 
        description: 'Provides insights and trend analysis on historical data.', 
        icon: TrendingUp, 
        color: 'text-green-500', 
        status: 'Deploying', 
        stats: '8 Reports Generated' 
    },
    { 
        id: 4, 
        name: 'User Support Assistant', 
        description: 'Handles common L1 requests and user guidance.', 
        icon: Users, 
        color: 'text-blue-500', 
        status: 'Active', 
        stats: '1500+ User Interactions' 
    },
    { 
        id: 5, 
        name: 'Configuration Auditor', 
        description: 'Monitors configuration items for compliance drift.', 
        icon: Server, 
        color: 'text-orange-500', 
        status: 'Inactive', 
        stats: 'Last Run: 2 Days Ago' 
    },
];

const ChatbotTemplate = () => {
    const [activeTab, setActiveTab] = useState('chatbot');
    const [isDarkMode, setIsDarkMode] = useState(false);
    
    // ===== LOGO CONFIGURATION =====
    // Replace these URLs with your actual logo image URLs
    // For best results, use transparent PNG images
    const lightModeLogo = 'https://www.wipro.com/content/dam/wipro/social-icons/wipro_new_logo.svg';
    const darkModeLogo = 'https://companieslogo.com/img/orig/WIT.D-91671412.png?t=1739861069';

    // ==============================
    
    // =================================================================================
    // --- AGENT REGISTRY ---
    // This is the "Agent Registry" for the frontend. 
    // To add a new agent to the chat UI, you only need to add a new object here.
    // - id: A unique string for the agent.
    // - name: The display name for the agent in the sidebar.
    // - description: A short description (currently unused, but good for reference).
    // - messages: The initial messages to display when the agent is selected.
    // - endpoint: The *CRITICAL* piece. This is the full URL to the agent's backend service (e.g., a Google Cloud Function URL).
    // =================================================================================
    const [agents, setAgents] = useState([
        {
            id: 'google-cloud-helper',
            name: 'Google Cloud Helper',
            description: 'I can help you with Google Cloud questions, billing, and basic operations.',
            messages: [
                { id: 1, type: 'bot', content: "Hello! I am the Google Cloud Helper. How can I assist you with GCP today?", timestamp: new Date().toISOString() }
            ],
            endpoint: 'https://us-central1-mahle-translation-poc.cloudfunctions.net/googleCloudHelper' 
        },
        {
            id: 'security-triage-alert',
            name: 'Security Triage Alert',
            description: 'I assist with triaging security alerts and running initial diagnostics.',
            messages: [
                { id: 1, type: 'bot', content: "Security agent online. Report any suspicious activity or ask for an alert status.", timestamp: new Date().toISOString() }
            ],
            endpoint: 'https://your-cloud-function-url-goes-here' // <-- TODO: Replace with your real backend URL
        }
    ]);


    const [currentAgentId, setCurrentAgentId] = useState('google-cloud-helper');
    const [currentMessage, setCurrentMessage] = useState('');
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    
    const fileInputRef = useRef(null);

    const activeAgent = agents.find(a => a.id === currentAgentId);

    // =================================================================================
    // --- AGENT DISPATCHER ---
    // This function acts as the "dispatcher". It does not contain any agent-specific "thinking" logic.
    // Its only job is to:
    // 1. Get the current user message.
    // 2. Find the active agent's backend URL (the `endpoint`).
    // 3. Send the message to that URL.
    // 4. Receive the response and add it to the message list.
    // =================================================================================
    const handleSendMessage = async () => {
        if (!activeAgent || (currentMessage.trim() === '' && uploadedFiles.length === 0)) {
            return;
        }

        const userMessage = {
            id: Date.now(),
            type: 'user',
            content: currentMessage,
            files: uploadedFiles.map(f => ({ name: f.name, size: f.size })),
            timestamp: new Date().toISOString()
        };

        // Add the user's message to the UI immediately
        setAgents(prevAgents => prevAgents.map(agent =>
            agent.id === currentAgentId ? { ...agent, messages: [...agent.messages, userMessage] } : agent
        ));
        
        setIsLoading(true);
        const messageToSend = currentMessage;
        setCurrentMessage('');
        setUploadedFiles([]);

        // --- This is where the frontend calls the backend ---
        // NOTE: For now, this will fail because the endpoint URLs are placeholders.
        // Once you deploy a backend agent, you will replace the placeholder URL in the agent registry above.
        try {
            // The 'fetch' API is the standard way to make HTTP requests from the browser.
            const response = await fetch(activeAgent.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                // The backend will receive a JSON object with the user's message.
                // You can add more data here if needed (e.g., conversation history).
                body: JSON.stringify({ message: messageToSend }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // The frontend expects the backend to return a JSON object with a "reply" property.
            const data = await response.json();

            const botResponse = {
                id: Date.now() + 1,
                type: 'bot',
                content: data.reply, // <-- The reply from your backend agent
                timestamp: new Date().toISOString(),
            };
            
            setAgents(prevAgents => prevAgents.map(agent =>
                agent.id === currentAgentId ? { ...agent, messages: [...agent.messages, botResponse] } : agent
            ));

        } catch (error) {
            console.error("Error calling backend agent:", error);
            const errorResponse = {
                id: Date.now() + 1,
                type: 'bot',
                content: `Sorry, I encountered an error trying to connect to my backend. (Error: ${error.message}). Please make sure the endpoint URL is correct and the backend service is running.`,
                timestamp: new Date().toISOString(),
            };
            setAgents(prevAgents => prevAgents.map(agent =>
                agent.id === currentAgentId ? { ...agent, messages: [...agent.messages, errorResponse] } : agent
            ));
        } finally {
            setIsLoading(false);
        }
    };


    const toggleDarkMode = () => {
        setIsDarkMode(!isDarkMode);
    };

    const handleFileUpload = (event) => {
        const files = Array.from(event.target.files);
        const validFiles = files.filter(file => file.size > 0);
        if (validFiles.length > 0) {
            setUploadedFiles(prev => [...prev, ...validFiles]);
        }
        if (event.target) {
            event.target.value = '';
        }
    };

    const removeFile = (index) => {
        setUploadedFiles(prev => prev.filter((_, i) => i !== index));
    };
    
    const getStatusColor = (status) => {
        switch(status) {
            case 'Active': return 'bg-green-500';
            case 'Deploying': return 'bg-yellow-500';
            case 'Inactive': return 'bg-gray-500';
            default: return 'bg-gray-400';
        }
    };

    const themeClass = isDarkMode ? 'dark bg-gray-900' : 'bg-gray-50';
    const cardClass = isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
    const textClass = isDarkMode ? 'text-gray-100' : 'text-gray-900';
    const textSecondaryClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
    const inputClass = isDarkMode ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500';
    const hoverClass = isDarkMode ? 'hover:bg-gray-700/70' : 'hover:bg-gray-100';

    const agentMessages = activeAgent ? activeAgent.messages : [];

    const AgentTile = ({ agent }) => {
        const Icon = agent.icon;
        return (
            <div className={`p-6 rounded-xl border transition-all duration-300 ease-in-out transform hover:scale-[1.02] hover:shadow-xl ${cardClass} ${hoverClass}`}>
                <div className="flex items-start justify-between">
                    <div className={`p-3 rounded-full ${agent.color} bg-opacity-10`}>
                        <Icon className={`w-6 h-6 ${agent.color}`} />
                    </div>
                    <div className="flex items-center space-x-2">
                        <div className={`w-3 h-3 rounded-full ${getStatusColor(agent.status)} ${agent.status === 'Active' ? 'animate-pulse' : ''}`}></div>
                        <span className={`text-sm font-medium ${textSecondaryClass}`}>{agent.status}</span>
                    </div>
                </div>
                <h3 className={`mt-4 text-xl font-semibold ${textClass}`}>{agent.name}</h3>
                <p className={`mt-1 text-sm ${textSecondaryClass}`}>{agent.description}</p>
                <div className={`mt-4 pt-3 border-t ${isDarkMode ? 'border-gray-700' : 'border-gray-200'} flex justify-between items-center`}>
                    <span className={`text-xs font-mono ${textSecondaryClass}`}>{agent.stats}</span>
                    <button className="text-blue-500 hover:text-blue-400 text-sm font-medium transition-colors flex items-center">
                        Details <Layers className='w-4 h-4 ml-1' />
                    </button>
                </div>
            </div>
        );
    };

    return (
        <div className={`min-h-screen transition-colors duration-300 ${themeClass} flex flex-col h-screen`}>
            {/* Header */}
            <header className={`${cardClass} border-b px-6 py-4 transition-colors duration-300 shadow-lg z-10 flex-shrink-0`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-6">
                        <div className="flex items-center space-x-3">
                            {/* Logo Image - automatically switches based on theme */}
                            <img 
                                src={isDarkMode ? darkModeLogo : lightModeLogo} 
                                alt="Company Logo" 
                                className="h-10 w-auto object-contain transition-opacity duration-300"
                                onError={(e) => {
                                    // Fallback to Shield icon if image fails to load
                                    e.target.style.display = 'none';
                                    e.target.nextElementSibling.style.display = 'block';
                                }}
                            />
                            {/* Fallback Icon (hidden by default, shown only if logo fails) */}
                            <Shield className="w-8 h-8 text-blue-600" style={{ display: 'none' }} />
                            
                            <div>
                                <h1 className={`text-xl font-bold ${textClass}`}>Google Cloud Agents </h1>
                            </div>
                        </div>
                        
                        <nav className={`flex rounded-xl p-1 shadow-inner ${isDarkMode ? 'bg-gray-700' : 'bg-gray-100'} hidden`}>
                            {[
                                { id: 'chatbot', label: 'AI Agents', icon: MessageCircle },
                                { id: 'agents', label: 'Agents', icon: Zap }
                            ].map((tab) => (
                                <button 
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                                        activeTab === tab.id 
                                            ? 'bg-blue-600 text-white shadow-md'
                                            : isDarkMode ? 'text-gray-300 hover:bg-gray-600' : 'text-gray-600 hover:bg-white'
                                    }`}
                                >
                                    <tab.icon className="w-4 h-4 mr-2" />
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
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
                        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                            <User className="w-4 h-4 text-white" />
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="flex-1 overflow-hidden p-6">
                
                {/* --- Agents Tab Content --- */}
                {activeTab === 'agents' && (
                    <div className="space-y-6 h-full overflow-y-auto">
                        <h2 className={`text-2xl font-bold ${textClass}`}>Autonomous Agents </h2>
                        <p className={`text-md ${textSecondaryClass}`}>
                            View and manage the specialized AI agents driving  automation.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                            {dummyAgents.map(agent => (
                                <AgentTile key={agent.id} agent={agent} />
                            ))}
                        </div>
                    </div>
                )}

                {/* --- Chatbot Tab Content --- */}
                {activeTab === 'chatbot' && (
                    <div className="h-full flex rounded-xl overflow-hidden shadow-2xl">
                        {/* Chat Sidebar */}
                        <div className={`w-80 flex-shrink-0 ${cardClass} border-r ${isDarkMode ? 'border-gray-700' : 'border-gray-200'} flex flex-col h-full`}>
                            <div className={`p-4 border-b flex-shrink-0 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                                <div className="mb-4">
                                    <h3 className={`font-semibold text-xl ${textClass}`}>Agents</h3>
                                </div>
                                <div className="flex items-center justify-between mb-4 hidden">
                                    <h3 className={`font-semibold text-lg ${textClass}`}>Sessions</h3>
                                    <button
                                        className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-transform transform hover:scale-110 shadow-md"
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                </div>
                                
                                <div className={`flex items-center space-x-2 p-3 rounded-xl ${isDarkMode ? 'bg-gray-700/50' : 'bg-blue-50'} hidden`}>
                                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                    <span className={`text-sm ${textSecondaryClass} font-medium`}>
                                        System Online
                                    </span>
                                </div>
                            </div>
                            <div className="overflow-y-auto flex-1 custom-scrollbar">
                                {agents.map((agent) => (
                                    <div
                                        key={agent.id}
                                        onClick={() => setCurrentAgentId(agent.id)}
                                        className={`p-4 border-b cursor-pointer transition-all duration-200 flex justify-between items-center group ${
                                            isDarkMode ? 'border-gray-700 hover:bg-gray-700/50' : 'border-gray-200 hover:bg-gray-100'
                                        } ${
                                            currentAgentId === agent.id 
                                                ? isDarkMode ? 'bg-gray-700 shadow-inner' : 'bg-blue-50/70 border-blue-300' 
                                                : ''
                                        }`}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <h4 className={`font-medium truncate ${currentAgentId === agent.id ? 'text-blue-500' : textClass}`}>{agent.name}</h4>
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
                                <div className="ml-auto flex items-center space-x-4">
                                </div>
                            </div>
                            {/* Chat Messages */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                {agentMessages.map((message) => (
                                    <div 
                                        key={message.id} 
                                        className={`flex transition-all duration-300 ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
                                    >
                                        <div className={`max-w-3xl p-4 rounded-xl shadow-lg animate-fade-in ${
                                            message.type === 'user'
                                                ? 'bg-blue-600 text-white rounded-br-none'
                                                : isDarkMode ? 'bg-gray-700 text-gray-100 rounded-tl-none border border-gray-600' : 'bg-white text-gray-900 rounded-tl-none border border-gray-200 shadow-md'
                                        }`}>
                                            <div className={`leading-relaxed whitespace-pre-wrap ${message.type === 'user' ? 'text-white' : textClass}`}>
                                                {message.content}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                
                                {isLoading && (
                                    <div className="flex justify-start">
                                        <div className={`max-w-2xl p-4 rounded-xl shadow-md rounded-tl-none border animate-pulse-fade ${isDarkMode ? 'bg-gray-700 text-gray-100 border-gray-600' : 'bg-white text-gray-900 border-gray-200'}`}>
                                            <div className="flex items-center space-x-2">
                                                <Loader className="w-5 h-5 animate-spin text-blue-600" />
                                                <span className={`text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-500'}`}>
                                                    AI Agents are typing...
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            
                            {/* Message Input Area */}
                            <div className={`p-6 border-t flex-shrink-0 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
                                {uploadedFiles.length > 0 && (
                                    <div className="mb-3 flex flex-wrap gap-2">
                                        {uploadedFiles.map((file, index) => (
                                            <div key={index} className={`flex items-center space-x-2 px-3 py-1 rounded-full border text-xs ${
                                                isDarkMode ? 'bg-gray-700 border-gray-600 text-gray-300' : 'bg-gray-100 border-gray-300 text-gray-700'
                                            }`}>
                                                <Paperclip className="w-3 h-3" />
                                                <span className="truncate max-w-[100px]">{file.name}</span>
                                                <button
                                                    onClick={() => removeFile(index)}
                                                    className="p-0.5 rounded-full hover:bg-gray-400 transition-colors text-gray-500 hover:text-white"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="flex items-center space-x-3">
                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        onChange={handleFileUpload}
                                        multiple
                                        className="hidden"
                                    />
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        className={`p-3 rounded-xl transition-colors ${
                                            isDarkMode ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                                        } disabled:opacity-50`}
                                        disabled={isLoading}
                                    >
                                        <Paperclip className="w-5 h-5" />
                                    </button>
                                    
                                    <input
                                        type="text"
                                        value={currentMessage}
                                        onChange={(e) => setCurrentMessage(e.target.value)}
                                        onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                                        placeholder="Ask something...."
                                        className={`flex-1 px-5 py-3 border rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500/50 focus:border-blue-500 transition-all duration-300 ${inputClass}`}
                                        disabled={isLoading}
                                    />
                                    <button
                                        onClick={handleSendMessage}
                                        className={`p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all duration-200 transform hover:scale-[1.05] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none`}
                                        disabled={(!currentMessage.trim() && uploadedFiles.length === 0) || isLoading}
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
                )}
            </main>
        </div>
    );
};

export default ChatbotTemplate;
