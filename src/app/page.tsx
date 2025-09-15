"use client";

import { useCallback, useRef, useState, useMemo, useEffect } from "react";
import Image from "next/image";

type LocalImage = { 
  id: string; 
  file?: File; // ✅ Make file optional
  previewUrl: string; 
};
type Turn = {
  id: string;
  when: number;
  items: { 
    imageId: string; 
    previewUrl: string; 
    question: string;        // ✅ Each item has its own question
    status: "pending" | "done" | "error"; 
    answer?: string; 
    error?: string 
  }[];
};

const CONSTANTS = {
  MAX_IMAGES: 4,
  MESSAGE_TIMEOUT: 3000,
  DEBOUNCE_DELAY: 300,
  MAX_IMAGE_SIZE: 1024,
  JPEG_QUALITY: 0.85
} as const;

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  
  useEffect(() => {
    const handleError = () => setHasError(true);
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);
  
  if (hasError) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900">Something went wrong</h2>
          <button 
            onClick={() => setHasError(false)}
            className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }
  
  return <>{children}</>;
};

export default function Home() {
  const [images, setImages] = useState<LocalImage[]>([]);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [currentChatCompleted, setCurrentChatCompleted] = useState(false);
  const [askedImageIds, setAskedImageIds] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Add loading state for better UX
  const [isProcessing, setIsProcessing] = useState(false);

  const [messageTimeout, setMessageTimeout] = useState<NodeJS.Timeout | null>(null);

  const showMessage = useCallback((msg: string) => {
    if (messageTimeout) clearTimeout(messageTimeout);
    setMessage(msg);
    const timeout = setTimeout(() => setMessage(null), CONSTANTS.MESSAGE_TIMEOUT);
    setMessageTimeout(timeout);
  }, [messageTimeout]);

  const onPick = useCallback((files: FileList | null) => {
    if (!files || currentChatCompleted) {
      if (currentChatCompleted) {
        showMessage("File limit reached. Please start a new chat to analyze more images.");
      }
      return;
    }
    
    const fileArray = Array.from(files);
    const availableSlots = CONSTANTS.MAX_IMAGES - images.length;
    const validFiles = fileArray.filter(file => file.type.startsWith("image/"));
    
    const filesToAdd = validFiles.slice(0, availableSlots);
    const skippedCount = validFiles.length - filesToAdd.length;
    
    if (filesToAdd.length === 0) return;
    
    const newImages: LocalImage[] = filesToAdd.map(file => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file)
    }));
    
    setImages(prev => [...prev, ...newImages]);
    
    if (skippedCount > 0) {
      showMessage(`Only ${CONSTANTS.MAX_IMAGES} images allowed. ${skippedCount} image(s) were not added.`);
    }
    
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [images.length, currentChatCompleted, showMessage]);

  const removeImage = (id: string) => {
    setImages((prev) => {
      const remaining = prev.filter((x) => x.id !== id);
      const removed = prev.find((x) => x.id === id);
      if (removed && removed.previewUrl.startsWith('blob:')) { // ✅ Check if it's a blob URL
        URL.revokeObjectURL(removed.previewUrl);
      }
      return remaining;
    });
  };

  const { isDisabled, buttonText, selectedTurn, askDisabled } = useMemo(() => {
    const validImages = images.filter(img => img.file);
    const hasValidImages = validImages.length > 0;
    const hasQuestion = question.trim().length > 0;
    
    return {
      // ✅ ONLY disable when you actually have 4 images (remove currentChatCompleted)
      isDisabled: images.length >= CONSTANTS.MAX_IMAGES,
      buttonText: images.length >= CONSTANTS.MAX_IMAGES 
        ? "Chat completed" 
        : `Add images (max ${CONSTANTS.MAX_IMAGES})`,
      selectedTurn: selectedTurnId ? turns.find(t => t.id === selectedTurnId) : null,
      askDisabled: !hasValidImages || !hasQuestion || isProcessing
    };
  }, [images, question, selectedTurnId, turns, isProcessing]); // ✅ Remove currentChatCompleted dependency

  async function fileToDataURL(file: File, maxSide = CONSTANTS.MAX_IMAGE_SIZE, quality = CONSTANTS.JPEG_QUALITY): Promise<string> {
    if (!file) throw new Error("File is undefined");
    
    return new Promise((resolve, reject) => {
      const img = document.createElement("img");
      const objUrl = URL.createObjectURL(file);
      
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas context unavailable");
          
          let { width, height } = img;
          const scale = Math.min(1, maxSide / Math.max(width, height));
          width = Math.round(width * scale);
          height = Math.round(height * scale);
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);
          
          URL.revokeObjectURL(objUrl);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (error) {
          URL.revokeObjectURL(objUrl);
          reject(error);
        }
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("Failed to load image"));
      };
      
      img.src = objUrl;
    });
  }

  async function ask() {
    if (askDisabled) return;
    
    setIsProcessing(true);
    try {
      const currentQuestion = question.trim();
      
      // ✅ Only process images that have actual files
      const imagesWithFiles = images.filter(img => img.file);
      
      if (imagesWithFiles.length === 0) {
        showMessage("No images to analyze");
        return;
      }
      
      // ✅ Compress images with better error handling
      const imgsWithData = await Promise.allSettled(
        imagesWithFiles.map(async (img) => ({ 
          id: img.id, 
          dataUrl: await fileToDataURL(img.file!) 
        }))
      );
      
      const successfulImages = imgsWithData
        .filter((result): result is PromiseFulfilledResult<{id: string, dataUrl: string}> => 
          result.status === 'fulfilled')
        .map(result => result.value);
      
      if (successfulImages.length === 0) {
        showMessage("Failed to process images. Please try again.");
        return;
      }
      
      // Check if we're continuing the current selected chat
      const existingTurn = selectedTurn; // Use the memoized value
      const isCurrentChat = existingTurn && !currentChatCompleted;
      
      let turnId: string;
      
      if (isCurrentChat) {
        // Continue existing chat - add ONLY new images
        turnId = selectedTurnId!;
        
        const existingImageIds = existingTurn ? existingTurn.items.map(item => item.imageId) : [];
        
        // Only add images that aren't already in the conversation
        const existingImageIdSet = new Set(existingImageIds);
        const newImageItems = successfulImages
          .filter(img => !existingImageIdSet.has(img.id))
          .map(img => ({ 
            imageId: img.id, 
            previewUrl: img.dataUrl, // ✅ This should be dataUrl, not img.previewUrl
            question: currentQuestion,
            status: "pending" as const 
          }));
        
        setTurns((prev) =>
          prev.map((t) =>
            t.id !== turnId ? t : { 
              ...t, 
              items: [...t.items, ...newImageItems],
              when: Date.now() 
            }
          )
        );
        
        // ✅ ONLY send NEW images to API (not all images)
        const newImagesForAPI = successfulImages.filter(img => !existingImageIds.includes(img.id));
        
        if (newImagesForAPI.length > 0) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const res = await fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ question: currentQuestion, images: newImagesForAPI }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || "Request failed");

            const answers: Record<string, string> = {};
            for (const r of data.results as { imageId: string; answer: string }[]) {
              answers[r.imageId] = r.answer;
            }

            // ✅ Update only the NEW items that were just analyzed
            setTurns((prev) =>
              prev.map((t) =>
                t.id !== turnId
                  ? t
                  : {
                      ...t,
                      items: t.items.map((it) =>
                        answers[it.imageId] // Only update items that got NEW responses
                          ? { ...it, status: "done", answer: answers[it.imageId] }
                          : it // Keep existing items unchanged
                      )
                    }
            ));
          } catch (error: unknown) {
            console.error('Error in ask function:', error);
          }
        }
        
      } else {
        // Create new chat - send ALL images (this part stays the same)
        turnId = crypto.randomUUID();
        setSelectedTurnId(turnId);
        const items = successfulImages.map((img) => ({ 
          imageId: img.id, 
          previewUrl: img.dataUrl,
          question: currentQuestion,
          status: "pending" as const 
        }));
        setTurns((prev) => [{ id: turnId, items, when: Date.now() }, ...prev]);
        
        // Send all images for new chat
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          const res = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: currentQuestion, images: successfulImages }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

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
          ));
          
          setCurrentChatCompleted(images.length === CONSTANTS.MAX_IMAGES);
          
        } catch (error: unknown) {
          console.error('Error in ask function:', error);
        }
      }

      setQuestion("");

      // ✅ Mark current images as asked (lock them)
      const imageIds = images.map(img => img.id);
      setAskedImageIds(prev => new Set([...prev, ...imageIds]));
      setCurrentChatCompleted(imageIds.length === CONSTANTS.MAX_IMAGES);
    } catch (error: unknown) {
      console.error('Error in ask function:', error);
      showMessage("Failed to analyze images. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  }

  const startNewChat = () => {
    setSelectedTurnId(null);
    setQuestion("");
    setCurrentChatCompleted(false);
    setAskedImageIds(new Set());
    
    // ✅ Don't revoke any URLs - conversations use data URLs anyway
    // The blob URLs will be cleaned up by the browser when images[] is cleared
    
    setImages([]);
  };

  const clearAllImages = useCallback(() => {
    images.forEach(img => {
      if (img.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(img.previewUrl);
      }
    });
    setImages([]);
    setAskedImageIds(new Set()); // ✅ Also clear asked IDs
  }, [images]);

  useEffect(() => {
    return () => {
      // Clear timeout
      if (messageTimeout) clearTimeout(messageTimeout);
      
      // Clean up blob URLs
      images.forEach(img => {
        if (img.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(img.previewUrl);
        }
      });
    };
  }, [messageTimeout, images]);

  return (
    <ErrorBoundary>
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
                    setCurrentChatCompleted(t.items.length === CONSTANTS.MAX_IMAGES);
                    
                    // ✅ Create display-only images without File objects
                    const chatImages: LocalImage[] = t.items.map(item => ({
                      id: item.imageId,
                      previewUrl: item.previewUrl
                      // ✅ No file property - it's optional now
                    }));
                    
                    setImages(chatImages);
                    setAskedImageIds(new Set(t.items.map(item => item.imageId)));
                    setQuestion("");
                  }}
                  className={`group relative p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedTurnId === t.id 
                      ? 'bg-blue-100 border border-blue-200' 
                      : 'bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <p className="text-sm font-medium text-gray-800 truncate pr-6">
                    {t.items[0]?.question || "New conversation"}  {/* ✅ Show first image's question */}
                  </p>
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
                    Question {images.length > 0 && `(${images.length}/${CONSTANTS.MAX_IMAGES} images)`}
                  </label>
                  <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault(); // Prevent new line
                        if (!askDisabled) {
                          ask(); // Submit the question
                        }
                      }
                      // Add Cmd/Ctrl+Enter as alternative
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        if (!askDisabled) ask();
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
                      disabled={isDisabled}  // ✅ Change from askDisabled to isDisabled
                      onClick={() => fileInputRef.current?.click()}
                      className={`rounded-xl border px-3 py-2 text-sm transition
                        ${!isDisabled  // ✅ Change from !askDisabled to !isDisabled
                          ? "border-gray-300 hover:bg-gray-50 text-gray-700" 
                          : "border-gray-200 text-gray-400 cursor-not-allowed"}`}
                    >
                      {buttonText}
                    </button>
                    
                    {/* Add this new Clear All button */}
                    {images.length > 0 && (
                      <button
                        onClick={clearAllImages}
                        className="rounded-xl border border-red-300 px-3 py-2 text-sm transition text-red-600 hover:bg-red-50"
                      >
                        Clear All
                      </button>
                    )}
                    
                    <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(e) => onPick(e.target.files)} className="hidden" />

                    <button
                      onClick={ask}
                      disabled={askDisabled}
                      className={`rounded-xl px-4 py-2 text-sm font-medium transition
                        ${askDisabled ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                    >
                      {isProcessing ? "Processing..." : "Ask"}
                    </button>
                  </div>
                </div>
                {/* thumbs */}
                <div className="grid grid-cols-2 gap-3 w-64">
                  {images.map((img, idx) => (
                    <div key={img.id} className="relative group overflow-hidden rounded-xl border border-gray-200">
                      <Image 
                        src={img.previewUrl} 
                        alt={`Upload ${idx + 1}`} 
                        width={200} 
                        height={128} 
                        className="h-32 w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" // ✅ Add click styles
                        unoptimized 
                        onClick={() => setPreviewImage(img.previewUrl)} // ✅ Add click handler
                      />
                      <button
                        onClick={() => removeImage(img.id)}
                        className={`absolute right-1 top-1 rounded-md bg-white/90 px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 text-gray-600 hover:bg-white
                          ${askedImageIds.has(img.id) ? 'hidden' : ''}`} // ✅ Hide if this image was asked about
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
            {selectedTurnId && selectedTurn && (
              <div className="mt-6">
                <div>
                  {/* Remove the global question display */}
                  {/* Delete this section: */}
                  {/* <div className="mb-4">
                    <h3 className="text-lg font-medium text-gray-900">Question:</h3>
                    <p className="text-gray-700 mt-1">{selectedTurn.question}</p>
                  </div> */}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {selectedTurn.items.map((it, idx) => (
                      <div key={idx} className="rounded-xl border border-gray-200 overflow-hidden bg-white transition-all duration-300 hover:shadow-md">
                        <Image 
                          src={it.previewUrl} 
                          alt={`image ${idx + 1}`} 
                          width={200} 
                          height={160} 
                          className="h-40 w-full object-cover cursor-pointer hover:opacity-90 transition-opacity" // ✅ Add click styles
                          unoptimized 
                          onClick={() => setPreviewImage(it.previewUrl)} // ✅ Add click handler
                        />
                        <div className="p-3 text-sm">
                          {/* Show the specific question for THIS image */}
                          <div className="mb-3 pb-2 border-b border-gray-100">
                            <p className="font-medium text-gray-800 text-xs mb-1">Question:</p>
                            <p className="text-gray-600 text-xs leading-relaxed">{it.question}</p>  {/* ✅ Use it.question not selectedTurn.question */}
                          </div>
                          
                          {it.status === "pending" && (
                            <div className="flex items-center gap-2">
                              <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                              <span className="text-gray-500">Analyzing...</span>
                            </div>
                          )}
                          {it.status === "done" && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <p className="font-medium text-gray-800 text-xs">Answer:</p>
                                <button 
                                  onClick={() => navigator.clipboard.writeText(it.answer || '')}
                                  className="text-xs text-blue-600 hover:text-blue-800"
                                >
                                  Copy
                                </button>
                              </div>
                              <p className="leading-relaxed text-gray-800 text-sm">{it.answer}</p>
                            </div>
                          )}
                          {it.status === "error" && (
                            <div className="text-red-600 text-sm">
                              <p className="font-medium">Analysis failed</p>
                              <p className="text-xs mt-1">Please try asking again</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
        
        {/* ✅ Update Image Preview Modal to be scrollable */}
        {previewImage && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-75 z-50 overflow-y-auto flex items-center justify-center p-4"
            onClick={() => setPreviewImage(null)}
          >
            <div 
              className="relative max-w-4xl max-h-full my-8"
              onClick={(e) => e.stopPropagation()} // ✅ Prevent closing when clicking on image
            >
              <Image 
                src={previewImage} 
                alt="Preview" 
                width={800} 
                height={600} 
                className="max-w-full max-h-full object-contain rounded-lg"
                unoptimized 
              />
              <button
                onClick={() => setPreviewImage(null)}
                className="absolute top-2 right-2 bg-white bg-opacity-80 hover:bg-opacity-100 rounded-full p-2 text-gray-800 transition-all"
              >
                ✕
              </button>
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}