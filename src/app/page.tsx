"use client";

import { useCallback, useRef, useState } from "react";

type LocalImage = { id: string; file: File; previewUrl: string };
type Turn = {
  id: string;
  question: string;
  items: { imageId: string; previewUrl: string; status: "pending" | "done" | "error"; answer?: string; error?: string }[];
  when: number;
};

export default function Home() {
  const [images, setImages] = useState<LocalImage[]>([]);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [currentChatCompleted, setCurrentChatCompleted] = useState(false);

  const onPick = useCallback((files: FileList | null) => {
    if (!files) return;
    
    // Check if current chat is completed and has images
    if (currentChatCompleted) {
      setMessage("File limit reached. Please start a new chat to analyze more images.");
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    
    const newOnes: LocalImage[] = [];
    let skippedCount = 0;
    
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (newOnes.length + images.length >= 4) {
        skippedCount = Array.from(files).length - newOnes.length;
        break;
      }
      const id = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      newOnes.push({ id, file, previewUrl });
    }
    
    if (newOnes.length === 0) return;
    
    setImages((prev) => [...prev, ...newOnes]);
    
    // Show user-friendly message if some images were skipped
    if (skippedCount > 0) {
      setMessage(`Only 4 images allowed. ${skippedCount} image(s) were not added.`);
      setTimeout(() => setMessage(null), 3000);
    }
    
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [images.length, currentChatCompleted]);

  const removeImage = (id: string) => {
    setImages((prev) => {
      const remaining = prev.filter((x) => x.id !== id);
      const removed = prev.find((x) => x.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return remaining;
    });
  };

  const disabled = images.length === 0 || !question.trim();

  async function fileToDataURL(file: File, maxSide = 1024, quality = 0.85): Promise<string> {
    // Add this safety check
    if (!file) {
      throw new Error("File is undefined");
    }
    
    // Downscale in-browser to shrink payload & token cost
    const img = document.createElement("img");
    const objUrl = URL.createObjectURL(file);
    await new Promise((res, rej) => {
      img.onload = () => res(true);
      img.onerror = rej;
      img.src = objUrl;
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    let { width, height } = img;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(objUrl);
    // use JPEG to compress even PNGs
    return canvas.toDataURL("image/jpeg", quality);
  }

  async function ask() {
    if (disabled) return;

    const currentQuestion = question.trim();
    
    // Check if we're continuing the current selected chat
    const isCurrentChat = selectedTurnId && turns.find(t => t.id === selectedTurnId);
    
    let turnId: string;
    
    if (isCurrentChat && !currentChatCompleted) {
      // Continue existing chat - add ONLY new images that aren't already in the turn
      turnId = selectedTurnId!;
      
      const existingTurn = turns.find(t => t.id === turnId);
      const existingImageIds = existingTurn ? existingTurn.items.map(item => item.imageId) : [];
      
      // Only add images that aren't already in the conversation
      const newImageItems = images
        .filter(img => !existingImageIds.includes(img.id))
        .map(img => ({ 
          imageId: img.id, 
          previewUrl: img.previewUrl, 
          status: "pending" as const 
        }));
      
      setTurns((prev) =>
        prev.map((t) =>
          t.id !== turnId ? t : { 
            ...t, 
            question: currentQuestion,
            items: [...t.items, ...newImageItems], // Add only new images
            when: Date.now() 
          }
        )
      );
    } else {
      // Create new chat (stays the same)
      turnId = crypto.randomUUID();
      setSelectedTurnId(turnId);
      const items = images.map((img) => ({ imageId: img.id, previewUrl: img.previewUrl, status: "pending" as const }));
      setTurns((prev) => [{ id: turnId, question: currentQuestion, items, when: Date.now() }, ...prev]);
    }

    setQuestion("");

    // Only compress CURRENT images (the new ones being uploaded)
    const imgsWithData = await Promise.all(
      images.map(async (img) => ({ id: img.id, dataUrl: await fileToDataURL(img.file) }))
    );

    // Send only the NEW images to API
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: currentQuestion, images: imgsWithData })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed");

      const answers: Record<string, string> = {};
      for (const r of data.results as { imageId: string; answer: string }[]) {
        answers[r.imageId] = r.answer;
      }

      // Update only the NEW items that were just analyzed
      setTurns((prev) =>
        prev.map((t) =>
          t.id !== turnId
            ? t
            : {
                ...t,
                items: t.items.map((it) =>
                  answers[it.imageId] // Only update items that got responses
                    ? { ...it, status: "done", answer: answers[it.imageId] }
                    : it // Keep existing items unchanged
                )
              }
        )
      );
      
      setCurrentChatCompleted(images.length === 4);
      
    } catch (e: any) {
      // Handle errors...
    }
  }

  const startNewChat = () => {
    setSelectedTurnId(null);
    setQuestion("");
    setCurrentChatCompleted(false); // Reset completion status
    images.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
  };

  const isDisabled = images.length >= 4 || currentChatCompleted;
  const buttonText = currentChatCompleted || images.length >= 4
    ? "Chat completed" 
    : "Add images (max 4)";

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Left Sidebar - Chat History */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Chat History</h2>
          
          {/* ADD THIS NEW CHAT BUTTON */}
          <button
            onClick={startNewChat}
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
          >
            <span>+</span> New Chat
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {turns.length === 0 ? (
            <p className="text-gray-500 text-sm">No conversations yet</p>
          ) : (
            turns.map((t) => (
              <div 
                key={t.id} 
                onClick={() => {
                  setSelectedTurnId(t.id);
                  // Check if this chat has 4 items (completed)
                  setCurrentChatCompleted(t.items.length === 4);
                  setImages([]); // Clear current images when viewing old chat
                  setQuestion("");
                }}
                className={`group relative p-3 rounded-lg cursor-pointer transition-colors ${
                  selectedTurnId === t.id 
                    ? 'bg-blue-100 border border-blue-200' 
                    : 'bg-gray-50 hover:bg-gray-100'
                }`}
              >
                <p className="text-sm font-medium text-gray-800 truncate pr-6">{t.question}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(t.when).toLocaleString()} • {t.items.length} images
                </p>
                
                {/* Simple close button on hover */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setTurns(prev => prev.filter(turn => turn.id !== t.id));
                    if (selectedTurnId === t.id) setSelectedTurnId(null);
                  }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200 bg-white">
          <h1 className="text-2xl font-semibold text-gray-900">BatchQuery Chatbot for Image Analysis</h1>
          <p className="mt-1 text-gray-600">
            Upload up to 4 product images, ask one question, and get a per-image answer in a chat-like view.
          </p>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Upload Section */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <label className="block text-sm mb-2 text-gray-700 font-medium">
                  Question {images.length > 0 && `(${images.length}/4 images)`}
                </label>
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault(); // Prevent new line
                      if (!disabled) {
                        ask(); // Submit the question
                      }
                    }
                  }}
                  placeholder='e.g., "How many books are in this image?" or "Any visible damage?"'
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 text-gray-900 placeholder-gray-500"
                  rows={2}
                />
                {/* Add this message display */}
                {message && (
                  <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
                    {message}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <button
                    disabled={isDisabled}
                    onClick={() => fileInputRef.current?.click()}
                    className={`rounded-xl border px-3 py-2 text-sm transition
                      ${!isDisabled 
                        ? "border-gray-300 hover:bg-gray-50 text-gray-700" 
                        : "border-gray-200 text-gray-400 cursor-not-allowed"}`}
                  >
                    {buttonText}
                  </button>
                  
                  {/* Add this new Clear All button */}
                  {images.length > 0 && (
                    <button
                      onClick={() => {
                        images.forEach(img => URL.revokeObjectURL(img.previewUrl));
                        setImages([]);
                      }}
                      className="rounded-xl border border-red-300 px-3 py-2 text-sm transition text-red-600 hover:bg-red-50"
                    >
                      Clear All
                    </button>
                  )}
                  
                  <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(e) => onPick(e.target.files)} className="hidden" />

                  <button
                    onClick={ask}
                    disabled={disabled}
                    className={`rounded-xl px-4 py-2 text-sm font-medium transition
                      ${disabled ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                  >
                    Ask
                  </button>
                </div>
              </div>
              {/* thumbs */}
              <div className="grid grid-cols-2 gap-3 w-64">
                {images.map((img) => (
                  <div key={img.id} className="relative group overflow-hidden rounded-xl border border-gray-200">
                    <img src={img.previewUrl} alt="preview" className="h-28 w-full object-cover" />
                    <button
                      onClick={() => removeImage(img.id)}
                      className={`absolute right-1 top-1 rounded-md bg-white/90 px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 text-gray-600 hover:bg-white
                        ${currentChatCompleted ? 'hidden' : ''}`} // Hide after chat completed
                      aria-label="Remove image"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Selected Conversation Results */}
          {selectedTurnId && (
            <div className="mt-6">
              {(() => {
                const selectedTurn = turns.find(t => t.id === selectedTurnId);
                if (!selectedTurn) return null;
                
                return (
                  <div>
                    <div className="mb-4">
                      <h3 className="text-lg font-medium text-gray-900">Question:</h3>
                      <p className="text-gray-700 mt-1">{selectedTurn.question}</p>
                    </div>
                    
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      {selectedTurn.items.map((it, idx) => (
                        <div key={idx} className="rounded-xl border border-gray-200 overflow-hidden bg-white transition-all duration-300 hover:shadow-md">
                          <img src={it.previewUrl} alt={`image ${idx + 1}`} className="h-40 w-full object-cover" />
                          <div className="p-3 text-sm">
                            {it.status === "pending" && (
                              <div className="flex items-center gap-2">
                                <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                                <span className="text-gray-500">Analyzing...</span>
                              </div>
                            )}
                            {it.status === "done" && (
                              <p className="leading-relaxed text-gray-800">{it.answer}</p>
                            )}
                            {it.status === "error" && <p className="text-red-600">Error: {it.error}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Show message when no conversation is selected */}
          {!selectedTurnId && turns.length > 0 && (
            <div className="mt-6 text-center py-12">
              <p className="text-gray-500">Select a conversation from the history to view results</p>
            </div>
          )}

          {/* footer */}
          <div className="mt-10 text-xs text-gray-500">
            Built with the OpenAI Vision API for batch image analysis.
          </div>
        </div>
      </div>
    </div>
  );
}