import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, Send, Mic, MicOff, Volume2, VolumeX, Trash2, Plus, 
  History, ShieldCheck, Brain, X, ArrowLeft, RefreshCw, MessageSquare
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AiThread, ChatMessage } from '../types';

interface GeminiAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialContext?: {
    type: 'protected_learning' | 'ppt' | 'song' | 'general';
    data?: any;
  };
}

export const GeminiAssistantModal: React.FC<GeminiAssistantModalProps> = ({
  isOpen,
  onClose,
  initialContext
}) => {
  const { token, user } = useAuth();
  const [threads, setThreads] = useState<AiThread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  const [memories, setMemories] = useState<string[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [speakOutput, setSpeakOutput] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const speechRecognitionRef = useRef<any>(null);

  // Load threads on modal open
  const fetchThreads = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/gemini/threads', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads || []);
        if (data.threads && data.threads.length > 0 && !currentThreadId) {
          const first = data.threads[0];
          setCurrentThreadId(first.id);
          setMessages(first.messages || []);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch AI threads:', err);
    }
  };

  const fetchMemories = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/gemini/memories', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMemories(data.memories || []);
      }
    } catch (err) {
      console.warn('Failed to fetch AI memories:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchThreads();
      fetchMemories();
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Handle Voice Input (Web Speech API)
  useEffect(() => {
    return () => {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.abort();
        } catch {
          // ignore
        }
        speechRecognitionRef.current = null;
      }
    };
  }, []);

  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  const toggleListening = () => {
    setVoiceNotice(null);
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceNotice('Voice recognition is not supported in this browser. You can type your question.');
      return;
    }

    if (isListening) {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch {
          try {
            speechRecognitionRef.current.abort();
          } catch {
            // ignore
          }
        }
      }
      setIsListening(false);
      return;
    }

    // Clean up any existing instance first
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch {
        // ignore
      }
      speechRecognitionRef.current = null;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setVoiceNotice('Listening to your voice... Speak now.');
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) {
          setInputText((prev) => (prev ? `${prev} ${transcript}` : transcript));
          setVoiceNotice('Voice captured. Press send or speak more.');
        }
        setIsListening(false);
      };

      recognition.onerror = (err: any) => {
        console.warn('Speech recognition notice:', err);
        setVoiceNotice('Microphone input completed or permission not granted.');
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      speechRecognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.warn('Speech recognition start failed safely:', err);
      setVoiceNotice('Could not access microphone.');
      setIsListening(false);
    }
  };

  // TTS Output
  const speakText = (text: string, force: boolean = false) => {
    if (!('speechSynthesis' in window)) return;
    if (!speakOutput && !force) return;
    window.speechSynthesis.cancel();
    const cleanText = text.replace(/[*_#`]/g, '');
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  const startNewThread = () => {
    setCurrentThreadId(null);
    setMessages([]);
    setShowHistory(false);
  };

  const selectThread = (thread: AiThread) => {
    setCurrentThreadId(thread.id);
    setMessages(thread.messages || []);
    setShowHistory(false);
  };

  const deleteCurrentThread = async () => {
    if (!currentThreadId || !token) return;
    try {
      await fetch(`/api/gemini/threads/${currentThreadId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setThreads((prev) => prev.filter((t) => t.id !== currentThreadId));
      startNewThread();
    } catch (err) {
      console.error('Delete conversation error:', err);
    }
  };

  const deleteAllThreads = async () => {
    if (!confirm('Are you sure you want to permanently erase ALL your AI conversations from the server?')) {
      return;
    }
    if (!token) return;
    try {
      await fetch('/api/gemini/threads', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setThreads([]);
      startNewThread();
    } catch (err) {
      console.error('Delete all conversations error:', err);
    }
  };

  const clearPersonalMemories = async () => {
    if (!token) return;
    try {
      await fetch('/api/gemini/memories', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setMemories([]);
    } catch (err) {
      console.error('Clear memories error:', err);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    const activeToken = token || localStorage.getItem('angel_class_token');
    if (!text || loading || !activeToken) return;

    setInputText('');
    setVoiceNotice(null);
    setLoading(true);

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({
          message: text,
          threadId: currentThreadId,
          contextType: initialContext?.type,
          contextData: initialContext?.data
        })
      });

      const data = await res.json();
      if (res.ok) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: data.reply,
          timestamp: new Date().toISOString()
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setCurrentThreadId(data.thread.id);
        fetchThreads();
        fetchMemories();
        speakText(data.reply);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.error || 'The spiritual connection is quiet. Please try again.',
            timestamp: new Date().toISOString()
          }
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Network connection is currently offline. Your question will be answered upon reconnecting.',
          timestamp: new Date().toISOString()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/75 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-4xl h-[92vh] max-h-[820px] rounded-2xl bg-[#0F382A] border border-amber-400/40 text-[#FDFBF7] shadow-2xl flex flex-col overflow-hidden relative">
        {/* Top Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 bg-[#082219] border-b border-amber-400/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="p-1.5 rounded-lg text-amber-300 hover:bg-emerald-900/60 relative"
              title="Conversation History"
            >
              <History className="w-5 h-5" />
              {threads.length > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              )}
            </button>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-amber-400/10 border border-amber-400/40 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-amber-300" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-serif-spiritual text-base sm:text-lg font-bold text-amber-200">
                    Angel Class AI Mentor
                  </h3>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-900 text-emerald-200 border border-emerald-700/60 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" /> Private & User-Isolated
                  </span>
                </div>
                <p className="text-[11px] text-emerald-200/70 hidden sm:block">
                  Personal spiritual guidance • Administrator strictly has zero access
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSpeakOutput(!speakOutput)}
              className={`p-2 rounded-lg text-xs font-semibold transition ${
                speakOutput ? 'bg-amber-400 text-emerald-950' : 'text-emerald-300 hover:bg-emerald-900/60'
              }`}
              title={speakOutput ? 'Spoken responses enabled' : 'Enable voice responses'}
            >
              {speakOutput ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setShowMemories(!showMemories)}
              className={`p-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                showMemories ? 'bg-amber-400 text-emerald-950' : 'text-emerald-300 hover:bg-emerald-900/60'
              }`}
              title="Personal AI Memory"
            >
              <Brain className="w-4 h-4" />
              <span className="hidden sm:inline">Memory</span>
            </button>

            <button
              onClick={startNewThread}
              className="p-2 rounded-lg text-xs font-semibold text-emerald-200 bg-emerald-900/80 hover:bg-emerald-800 flex items-center gap-1"
              title="Start New Discussion"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New</span>
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-lg text-emerald-300 hover:text-white hover:bg-emerald-900/60"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body Area */}
        <div className="flex-1 flex overflow-hidden relative">
          {/* Conversation History Drawer */}
          {showHistory && (
            <div className="absolute inset-y-0 left-0 w-72 sm:w-80 bg-[#0A261D] border-r border-amber-400/30 z-30 p-4 flex flex-col shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between pb-3 border-b border-emerald-800/80">
                <h4 className="font-serif-spiritual text-sm font-bold text-amber-200 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-400" /> Past Conversations
                </h4>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-emerald-300 hover:text-white p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-3 space-y-2">
                {threads.length === 0 ? (
                  <p className="text-xs text-emerald-300/60 text-center py-8">
                    No past conversations recorded yet.
                  </p>
                ) : (
                  threads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() => selectThread(thread)}
                      className={`w-full text-left p-2.5 rounded-xl text-xs transition border ${
                        currentThreadId === thread.id
                          ? 'bg-amber-400/20 border-amber-400/50 text-amber-100 font-medium'
                          : 'bg-emerald-900/40 border-emerald-800/40 text-emerald-200/90 hover:bg-emerald-900/80'
                      }`}
                    >
                      <p className="truncate font-semibold">{thread.title}</p>
                      <p className="text-[10px] text-emerald-400/70 mt-1">
                        {new Date(thread.updatedAt).toLocaleDateString()}
                      </p>
                    </button>
                  ))
                )}
              </div>

              {threads.length > 0 && (
                <div className="pt-3 border-t border-emerald-800/80">
                  <button
                    onClick={deleteAllThreads}
                    className="w-full py-2 rounded-xl bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/40 text-rose-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Erase All Conversations
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Personal Memory Drawer */}
          {showMemories && (
            <div className="absolute inset-y-0 right-0 w-80 bg-[#0A261D] border-l border-amber-400/30 z-30 p-4 flex flex-col shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between pb-3 border-b border-emerald-800/80">
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 text-amber-300" />
                  <h4 className="font-serif-spiritual text-sm font-bold text-amber-200">
                    Personal AI Memory
                  </h4>
                </div>
                <button onClick={() => setShowMemories(false)} className="text-emerald-300 hover:text-white p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 my-2 rounded-xl bg-emerald-950/70 border border-emerald-800/60 text-[11px] text-emerald-200/90">
                <ShieldCheck className="w-4 h-4 text-amber-300 inline mr-1.5" />
                These personal preferences and spiritual intentions are strictly kept in your private account. Administrators can never view your personal AI memory.
              </div>

              <div className="flex-1 overflow-y-auto py-2 space-y-2">
                {memories.length === 0 ? (
                  <p className="text-xs text-emerald-300/60 text-center py-8">
                    No personal memory retained yet. Share your spiritual goals and practices in conversation.
                  </p>
                ) : (
                  memories.map((m, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-xl bg-emerald-900/30 border border-emerald-800/50 text-xs text-amber-100/90"
                    >
                      &quot;{m}&quot;
                    </div>
                  ))
                )}
              </div>

              {memories.length > 0 && (
                <div className="pt-3 border-t border-emerald-800/80">
                  <button
                    onClick={clearPersonalMemories}
                    className="w-full py-2 rounded-xl bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/40 text-rose-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Clear Personal Memories
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Chat Messages Stream */}
          <div className="flex-1 flex flex-col justify-between overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto py-10">
                  <div className="w-16 h-16 rounded-2xl bg-amber-400/10 border border-amber-400/40 flex items-center justify-center mb-4">
                    <Sparkles className="w-8 h-8 text-amber-300 animate-pulse" />
                  </div>
                  <h4 className="font-serif-spiritual text-xl font-bold text-amber-200 mb-2">
                    Welcome, {user?.name || 'Friend'}!
                  </h4>
                  <p className="text-xs text-emerald-200/80 mb-6 leading-relaxed">
                    I am your Angel Class AI Mentor! Ask me anything about science, maths, creative stories, space, history, general knowledge, or positive life advice.
                  </p>

                  {/* Suggestion Chips */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full text-left">
                    <button
                      onClick={() => handleSendMessage('Why do leaves change color in autumn? Explain simply.')}
                      className="p-2.5 rounded-xl bg-emerald-900/50 hover:bg-emerald-800/80 border border-emerald-700/50 text-xs text-amber-100/90 transition"
                    >
                      🔬 Why do leaves change color?
                    </button>
                    <button
                      onClick={() => handleSendMessage('What is 15% of 80? Show me the step-by-step calculation.')}
                      className="p-2.5 rounded-xl bg-emerald-900/50 hover:bg-emerald-800/80 border border-emerald-700/50 text-xs text-amber-100/90 transition"
                    >
                      ➗ What is 15% of 80? (with steps)
                    </button>
                    <button
                      onClick={() => handleSendMessage('Write a fun 3-sentence story about an astronaut and a friendly robot on Mars.')}
                      className="p-2.5 rounded-xl bg-emerald-900/50 hover:bg-emerald-800/80 border border-emerald-700/50 text-xs text-amber-100/90 transition"
                    >
                      🚀 Astronaut & robot short story
                    </button>
                    <button
                      onClick={() => handleSendMessage('How can I stay calm and focused when solving difficult problems?')}
                      className="p-2.5 rounded-xl bg-emerald-900/50 hover:bg-emerald-800/80 border border-emerald-700/50 text-xs text-amber-100/90 transition"
                    >
                      🕊️ Tips for calm focus & study
                    </button>
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-emerald-950 font-medium rounded-br-none shadow-md'
                          : 'bg-[#164E3D] text-[#FDFBF7] border border-amber-400/20 rounded-bl-none shadow-md'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                      <div className="flex items-center justify-between mt-1.5 pt-1 border-t border-white/10">
                        <span
                          className={`text-[10px] opacity-70 ${
                            msg.role === 'user' ? 'text-emerald-950' : 'text-emerald-300'
                          }`}
                        >
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>

                        {msg.role === 'assistant' && (
                          <button
                            type="button"
                            onClick={() => speakText(msg.content, true)}
                            className="text-emerald-300 hover:text-amber-300 p-0.5 rounded transition"
                            title="Listen to this response spoken aloud"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}

              {loading && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-none px-4 py-3 bg-[#164E3D] border border-amber-400/20 text-amber-200 text-xs flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                    <span>Thinking and generating your answer...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="p-3 sm:p-4 bg-[#082219] border-t border-amber-400/30">
              {voiceNotice && (
                <div className="mb-2 px-3 py-1.5 rounded-xl bg-amber-400/15 border border-amber-400/30 text-amber-200 text-xs flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-amber-400" />
                    {voiceNotice}
                  </span>
                  <button onClick={() => setVoiceNotice(null)} className="text-amber-300 hover:text-white text-xs">✕</button>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="flex items-center gap-2"
              >
                {/* Voice Input Button */}
                <button
                  type="button"
                  onClick={toggleListening}
                  className={`p-2.5 rounded-xl border transition ${
                    isListening
                      ? 'bg-rose-600 border-rose-400 text-white animate-pulse'
                      : 'bg-emerald-900/60 border-emerald-700/60 text-amber-300 hover:bg-emerald-800'
                  }`}
                  title={isListening ? 'Listening... click to stop' : 'Click to speak your message'}
                >
                  {isListening ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                </button>

                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={isListening ? 'Listening to your voice...' : 'Ask any question — science, maths, stories, reasoning, space...'}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-[#0F382A] border border-emerald-700/70 text-sm text-[#FDFBF7] placeholder-emerald-300/40 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
                />

                <button
                  type="submit"
                  disabled={!inputText.trim() || loading}
                  className="p-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-emerald-950 font-bold hover:brightness-105 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none shadow"
                  title="Send message"
                >
                  <Send className="w-4 h-4" />
                </button>

                {currentThreadId && (
                  <button
                    type="button"
                    onClick={deleteCurrentThread}
                    className="p-2.5 rounded-xl text-rose-300/70 hover:text-rose-300 hover:bg-rose-950/40 transition"
                    title="Delete current conversation"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
