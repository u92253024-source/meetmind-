import React, { useState, useRef, useEffect } from "react";
import { GoogleGenAI, Type } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  Download, 
  Clipboard, 
  ChevronRight,
  FileUp,
  Search,
  LayoutGrid,
  List,
  X,
  Trash2,
  Plus,
  Layers,
  FileCheck,
  Cloud,
  LogOut,
  LogIn,
  History
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Firebase imports
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  collection, 
  addDoc, 
  getDocs, 
  query, 
  orderBy, 
  serverTimestamp,
  writeBatch,
  getDoc,
  getDocFromServer
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  const jsonError = JSON.stringify(errInfo);
  console.error('Firestore Error: ', jsonError);
  throw new Error(jsonError);
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const getAcademicYear = (proposal: { meetingName: string; fileName: string }) => {
  const meetingMatch = proposal.meetingName.match(/(\d+)\s*學年度/);
  if (meetingMatch) return meetingMatch[1];
  const fileMatch = (proposal.fileName || "").match(/^(\d+)/);
  if (fileMatch) return fileMatch[1];
  return "其他";
};

interface Proposal {
  meetingName: string;
  title: string;
  unit: string;
  content: string;
  result: string;
  fileName: string;
  page: number | null;
  id: string;
  createdAt?: any;
}

interface FileItem {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'completed' | 'error';
  results: Proposal[];
  error?: string;
}

const SYSTEM_INSTRUCTION = `你是一位專業的會議記錄結構化提取助理，專門處理國立政治大學（NCCU）教務會議的 PDF 文件。
你的任務是從會議記錄中，精確提取每一個提案的結構化資料。

## 你的工作分為兩個階段，必須依序執行：

### 第一階段：預處理（定位有效範圍）
掃描全文，找出「討論區段」的起點與終點：
起點（取最先出現者）：報告案、討論事項、討論案由、討論提案、討論議案、討論項目、討論議題、提案討論、議案討論、戊、（後接討論相關字樣）
終點（取最先出現者）：散會、會議結束、閉會、庚、辛、

### 第二階段：結構化提取
在有效範圍內，將每個提案提取為 JSON 格式，必須嚴格遵守以下欄位定義：

1. meetingName: 
   - 參考文件第一頁，說明該次會議的完整名稱。
   - 格式例：國立政治大學 100 學年度第 2 學期第 2 次教務會議

2. title: 
   - 提案的完整標題。
   - 格式例：【提案十五】為本校 101 學年度變更授予學生中、英文學位名稱報部核備案，提請討論。

3. unit: 
   - 提案單位。
   - 格式例：教務處

4. content: 
   - 提案的說明或內容。

5. result: 
   - 該提案的決議結果。

6. fileName: 
   - 填入提供的來源檔案名稱（包含副檔名）。
   - 必須與來源檔名完全一致。

7. page: 
   - 填入該提案在 PDF 中首次出現的頁碼（整數，不加引號）。
   - 若無法確定頁碼，填入 null。

8. id: 
   - 每筆提案產生一組唯一的 9 碼隨機英數字串（小寫英文字母與數字混合）。
   - 格式例：t5x1z3v8c、a2m7k9p1q

請確保輸出的 JSON 是一個陣列，包含所有識別出的提案。`;

export default function App() {
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [confirmedResults, setConfirmedResults] = useState<Proposal[]>([]);
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [msgModal, setMsgModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm?: () => void;
    confirmText?: string;
    cancelText?: string;
    type?: 'danger' | 'info' | 'success';
  }>({
    isOpen: false,
    title: '',
    message: '',
    confirmText: '確定',
    cancelText: '取消'
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showConfirm = (title: string, message: string, onConfirm: () => void, type: 'danger' | 'info' | 'success' = 'info') => {
    setMsgModal({
      isOpen: true,
      title,
      message,
      onConfirm,
      type,
      confirmText: '確定',
      cancelText: '取消'
    });
  };

  const showAlert = (title: string, message: string) => {
    setMsgModal({
      isOpen: true,
      title,
      message,
      confirmText: '瞭解',
      type: 'info'
    });
  };

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        testConnection();
        fetchMasterData();
      }
    });
    return () => unsubscribe();
  }, []);

  const testConnection = async () => {
    try {
      // 依照指示測試連線
      await getDocFromServer(doc(db, 'test', 'connection'));
      setIsOffline(false);
    } catch (error: any) {
      if (error.message && error.message.includes('the client is offline')) {
        setIsOffline(true);
        console.error("Firebase is offline. Please check your project settings.");
      }
    }
  };

  const fetchMasterData = async () => {
    try {
      setIsSyncing(true);
      // 改用 getDocFromServer 解決離線錯誤並確保資料最新
      const masterDoc = await getDocFromServer(doc(db, "master", "data"));
      if (masterDoc.exists()) {
        const data = masterDoc.data();
        if (data.proposals) {
          setConfirmedResults(data.proposals);
        }
      }
    } catch (err: any) {
      console.error("Error fetching master data:", err);
      if (err.message && err.message.includes('the client is offline')) {
        setIsOffline(true);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setConfirmedResults([]);
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files).map(file => ({
        id: Math.random().toString(36).substring(7),
        file,
        status: 'pending' as const,
        results: []
      }));
      setFileItems(prev => [...prev, ...newFiles]);
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeFile = (id: string) => {
    setFileItems(prev => prev.filter(item => item.id !== id));
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const processFile = async (fileItemId: string) => {
    const item = fileItems.find(i => i.id === fileItemId);
    if (!item || item.status === 'processing') return;

    // 按下下一輪開始提取時，清空隊列中已完成的其他檔案
    setFileItems(prev => prev.filter(i => i.status !== 'completed' || i.id === fileItemId));

    setFileItems(prev => prev.map(i => i.id === fileItemId ? { ...i, status: 'processing', error: undefined } : i));

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(item.file);
      const base64Data = await base64Promise;

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "application/pdf",
                },
              },
              {
                text: `來源檔案名稱：${item.file.name}\n\n請根據系統指令提取此 PDF 中的會議提案資料。`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                meetingName: { type: Type.STRING },
                title: { type: Type.STRING },
                unit: { type: Type.STRING },
                content: { type: Type.STRING },
                result: { type: Type.STRING },
                fileName: { type: Type.STRING },
                page: { type: Type.INTEGER, nullable: true },
                id: { type: Type.STRING },
              },
              required: ["meetingName", "title", "unit", "content", "result", "fileName", "id"],
            },
          },
        },
      });

      const text = response.text;
      if (text) {
        const parsed = JSON.parse(text) as Proposal[];
        setFileItems(prev => prev.map(i => i.id === fileItemId ? { ...i, status: 'completed', results: parsed } : i));
      } else {
        throw new Error("未能從文件中提取到資料。");
      }
    } catch (err: any) {
      console.error(err);
      setFileItems(prev => prev.map(i => i.id === fileItemId ? { ...i, status: 'error', error: err.message || "處理文件時發生錯誤。" } : i));
    }
  };

  const confirmResults = async (fileItemId: string, specificIds?: Set<string>) => {
    const item = fileItems.find(i => i.id === fileItemId);
    if (!item || item.results.length === 0) return;

    let toAdd: Proposal[] = [];
    if (specificIds && specificIds.size > 0) {
      toAdd = item.results.filter(r => specificIds.has(r.id));
    } else {
      toAdd = [...item.results];
    }

    // 1. 強化去重處理：只有當「會議名稱」與「原始標題」皆相同時，才視為重複提案
    // 不同年度/會議的相同提案內容應視為不同個體，需賦予唯一 ID
    const existingFullKeys = new Set(confirmedResults.map(p => `${p.meetingName.trim()}|${p.title.trim()}`));
    const existingIds = new Set(confirmedResults.map(p => p.id));
    const allExistingTitles = new Set(confirmedResults.map(p => p.title.trim()));
    
    const uniqueToAdd: Proposal[] = [];
    const currentBatchKeys = new Set<string>();

    for (const p of toAdd) {
      const trimmedTitle = p.title.trim();
      const fullKey = `${p.meetingName.trim()}|${trimmedTitle}`;
      
      if (!existingFullKeys.has(fullKey) && !currentBatchKeys.has(fullKey)) {
        let finalId = p.id;
        let finalTitle = p.title;
        const year = getAcademicYear(p);

        // 如果 ID 衝突（不同內容拿到同 ID），或是標題在不同年度重複出現
        // 則調整 ID 與標題使其具備辨識度
        if (existingIds.has(finalId)) {
          finalId = `${year}_${p.id}_${Math.random().toString(36).substring(7, 10)}`;
        }

        // 如果標題在現有資料中已存在（但會議不同），則在標題前冠上學年度供辨識
        if (allExistingTitles.has(trimmedTitle)) {
          finalTitle = `[${year}學年度] ${trimmedTitle}`;
        }
        
        const newProposal = { ...p, id: finalId, title: finalTitle };
        uniqueToAdd.push(newProposal);
        existingIds.add(finalId);
        currentBatchKeys.add(fullKey);
      }
    }
    
    if (uniqueToAdd.length === 0) {
      const duplicateMsg = toAdd.length === 1 
        ? "該提案已存在於歸檔中（會議及標題均重複）。" 
        : "所選提案均已存在於歸檔中，無需重複加入。";
      showAlert("歸檔檢查", duplicateMsg);
      setFileItems(prev => prev.map(i => i.id === fileItemId ? { ...i, status: 'completed' } : i));
      setSelectedProposalIds(new Set());
      return;
    }

    // 2. 更新本地狀態
    const newConfirmed = [...confirmedResults, ...uniqueToAdd];
    setConfirmedResults(newConfirmed);

    // Sync to Firebase if logged in
    if (user) {
      try {
        setIsSyncing(true);
        const batch = writeBatch(db);
        
        // 1. Archive the individual session (keeps record of what was attempted/added this time)
        const archiveRef = doc(collection(db, "archives"));
        batch.set(archiveRef, {
          fileName: item.file.name,
          addedProposals: uniqueToAdd, // 只紀錄真正新增的部分
          totalAttempted: toAdd.length,
          timestamp: serverTimestamp(),
          userId: user.uid
        });

        // 2. Add individual proposals to the master collection
        uniqueToAdd.forEach(p => {
          const pRef = doc(db, "proposals", p.id);
          batch.set(pRef, {
            ...p,
            createdAt: serverTimestamp(),
            userId: user.uid
          });
        });

        // 3. Update the singleton master/data document (the dynamic data.json)
        const masterRef = doc(db, "master", "data");
        batch.set(masterRef, {
          proposals: newConfirmed,
          lastUpdated: serverTimestamp(),
          updatedBy: user.email
        }, { merge: true });

        await batch.commit();
      } catch (err) {
        console.error("Firebase sync error:", err);
        showAlert("同步錯誤", "存檔失敗，但已更新本地畫面。");
      } finally {
        setIsSyncing(false);
      }
    }

    // 將確認狀態設為完成，但不直接從隊列中移除，保留審閱狀態
    setFileItems(prev => prev.map(i => i.id === fileItemId ? { ...i, status: 'completed' } : i));
    setSelectedProposalIds(new Set());
  };

  const toggleProposalSelection = (id: string) => {
    const newSelected = new Set(selectedProposalIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedProposalIds(newSelected);
  };

  const toggleAllInFile = (fileItemId: string) => {
    const item = fileItems.find(i => i.id === fileItemId);
    if (!item) return;
    
    const allIds = item.results.map(r => r.id);
    const areAllSelected = allIds.every(id => selectedProposalIds.has(id));
    
    const newSelected = new Set(selectedProposalIds);
    if (areAllSelected) {
      allIds.forEach(id => newSelected.delete(id));
    } else {
      allIds.forEach(id => newSelected.add(id));
    }
    setSelectedProposalIds(newSelected);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const downloadCombinedJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(confirmedResults, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "combined_proposals.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const [selectedConfirmedIds, setSelectedConfirmedIds] = useState<Set<string>>(new Set());

  const toggleConfirmedSelection = (id: string) => {
    const newSelection = new Set(selectedConfirmedIds);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedConfirmedIds(newSelection);
  };

  const deleteSelectedConfirmed = async () => {
    if (selectedConfirmedIds.size === 0) return;
    
    showConfirm(
      "確認刪除", 
      `確定要刪除選取的 ${selectedConfirmedIds.size} 筆提案嗎？這將同步更新雲端資料庫。`,
      async () => {
        const originalResults = [...confirmedResults];
        const newConfirmed = confirmedResults.filter(p => !selectedConfirmedIds.has(p.id));
        
        // 先更新本地狀態讓 UI 有反應
        setConfirmedResults(newConfirmed);
        const itemsToDelete = Array.from(selectedConfirmedIds);
        setSelectedConfirmedIds(new Set());

        if (user) {
          try {
            setIsSyncing(true);
            const batch = writeBatch(db);
            
            // 1. 同步更新 Master Data
            const masterRef = doc(db, "master", "data");
            batch.set(masterRef, {
              proposals: newConfirmed,
              lastUpdated: serverTimestamp(),
              updatedBy: user.email
            }, { merge: true });

            // 2. 從 proposals 集合中移除
            itemsToDelete.forEach(id => {
              const pRef = doc(db, "proposals", id);
              batch.delete(pRef);
            });

            await batch.commit();
            console.log("Sync success: deletion complete");
          } catch (err: any) {
            console.error("Firebase delete sync error:", err);
            // 發生錯誤時回滾本地狀態
            setConfirmedResults(originalResults);
            
            try {
              handleFirestoreError(err, OperationType.WRITE, "master/data (batch)");
            } catch (formattedErr: any) {
              showAlert("刪除失敗", `雲端同步刪除失敗: ${err.message || '請檢查網路權限'}`);
            }
          } finally {
            setIsSyncing(false);
          }
        }
      },
      'danger'
    );
  };

  const clearStaging = async () => {
    showConfirm(
      "清空歸檔",
      "確定要清空已存儲的所有合併提案嗎？這將會同步重設雲端資料。",
      async () => {
        setConfirmedResults([]);
        setExpandedYears(new Set());
        if (user) {
          try {
            setIsSyncing(true);
            await setDoc(doc(db, "master", "data"), { 
              proposals: [], 
              lastUpdated: serverTimestamp(),
              updatedBy: user.email 
            });
          } catch (err) {
            console.error("Firebase reset error:", err);
            showAlert("重設失敗", "重設雲端資料時發生錯誤。");
          } finally {
            setIsSyncing(false);
          }
        }
      },
      'danger'
    );
  };

  const toggleYear = (year: string) => {
    const next = new Set(expandedYears);
    if (next.has(year)) {
      next.delete(year);
    } else {
      next.add(year);
    }
    setExpandedYears(next);
  };

  const groupedResults = confirmedResults.reduce((acc, p) => {
    const year = getAcademicYear(p);
    if (!acc[year]) acc[year] = [];
    acc[year].push(p);
    return acc;
  }, {} as Record<string, Proposal[]>);

  const sortedYears = Object.keys(groupedResults).sort((a, b) => {
    if (a === "其他") return 1;
    if (b === "其他") return -1;
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
  });

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#1E293B] font-sans selection:bg-blue-100">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
              <FileText className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900">政大教務會議提案提取助手</h1>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">教務處專業助理</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {isOffline && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-3 py-1.5 rounded-lg border border-red-100">
                <AlertCircle className="w-4 h-4" />
                <span className="text-xs font-bold">雲端離線中</span>
              </div>
            )}
            
            {isSyncing && (
              <div className="flex items-center gap-2 text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 animate-pulse">
                <Cloud className="w-4 h-4" />
                <span className="text-xs font-bold">同步中...</span>
              </div>
            )}
            
            {!user ? (
              <button 
                onClick={login}
                className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 text-sm font-bold rounded-xl hover:bg-slate-200 transition-all border border-slate-200"
              >
                <LogIn className="w-4 h-4" />
                <span>登入歸檔 (Google)</span>
              </button>
            ) : (
              <div className="flex items-center gap-4">
                <div className="hidden sm:flex flex-col items-end">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-none">Logged in as</span>
                  <span className="text-xs font-bold text-slate-700 leading-tight">{user.email}</span>
                </div>
                <button 
                  onClick={logout}
                  className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                  title="登出"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}

            {confirmedResults.length > 0 && (
              <div className="flex items-center gap-2">
                {selectedConfirmedIds.size > 0 && (
                  <button 
                    onClick={deleteSelectedConfirmed}
                    className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 text-xs font-bold rounded-lg hover:bg-red-100 transition-all border border-red-100"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>刪除所選 ({selectedConfirmedIds.size})</span>
                  </button>
                )}
                <button 
                  onClick={clearStaging}
                  className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                  title="清空暫存區"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
                <button 
                  onClick={downloadCombinedJson}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all"
                >
                  <Download className="w-4 h-4" />
                  <span>下載合併 JSON ({confirmedResults.length})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* File List & Preview */}
        <section className="mb-12">
          <div className="max-w-4xl mx-auto">
            <div 
              className="relative group cursor-pointer rounded-2xl border-2 border-dashed border-slate-300 hover:border-blue-400 hover:bg-slate-50 transition-all duration-300 p-10 text-center"
              onClick={handleUploadClick}
            >
              <input 
                type="file" 
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".pdf"
                multiple
                className="hidden"
              />
              
              <div className="flex flex-col items-center">
                <div className="w-16 h-16 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110">
                  <Upload className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-semibold text-slate-900 mb-2">上傳會議記錄 PDF</h2>
                <p className="text-slate-500">拖放多個 PDF 檔案至此，或點擊瀏覽選取檔案</p>
              </div>
            </div>

            {/* File List */}
            {fileItems.length > 0 && (
              <div className="mt-8 space-y-6">
                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest px-1">處理隊列</h3>
                {fileItems.map((item) => (
                  <div key={item.id} className="space-y-4">
                    <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={cn(
                        "bg-white rounded-2xl border p-4 flex items-center justify-between shadow-sm transition-colors",
                        item.status === 'completed' ? "border-green-200 bg-green-50/20" : "border-slate-200"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center",
                          item.status === 'completed' ? "bg-green-100 text-green-600" :
                          item.status === 'error' ? "bg-red-100 text-red-600" :
                          "bg-blue-100 text-blue-600"
                        )}>
                          {item.status === 'processing' ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                        </div>
                        <div>
                          <p className="font-bold text-slate-900 truncate max-w-[200px] sm:max-w-md">{item.file.name}</p>
                          <p className="text-xs text-slate-500">
                            {(item.file.size / 1024 / 1024).toFixed(2)} MB • 
                            <span className={cn(
                              "ml-1 font-semibold",
                              item.status === 'completed' ? "text-green-600" :
                              item.status === 'error' ? "text-red-600" :
                              item.status === 'processing' ? "text-blue-600" : "text-slate-400"
                            )}>
                              {item.status === 'pending' && "等待中"}
                              {item.status === 'processing' && "提取中..."}
                              {item.status === 'completed' && `成功提取 ${item.results.length} 筆提案`}
                              {item.status === 'error' && "處理失敗"}
                            </span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {item.status === 'pending' && (
                          <button 
                            onClick={() => processFile(item.id)}
                            className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition-all flex items-center gap-2"
                          >
                            <Search className="w-4 h-4" />
                            開始提取
                          </button>
                        )}
                        {item.status === 'completed' && (
                          <button 
                            onClick={() => confirmResults(item.id)}
                            className="px-4 py-2 bg-green-600 text-white text-sm font-bold rounded-lg hover:bg-green-700 transition-all flex items-center gap-2 shadow-lg shadow-green-100"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            Confirm & Add to Staging
                          </button>
                        )}
                        <button 
                          onClick={() => removeFile(item.id)}
                          className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </motion.div>

                    {/* Full Review Area for this specific file before confirming */}
                    {item.status === 'completed' && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="ml-4 sm:ml-14 mt-2 bg-slate-50/50 rounded-2xl border border-green-100 overflow-hidden"
                      >
                        <div className="p-4 border-b border-green-100 bg-green-50/30 flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                              <p className="text-xs font-bold text-green-700 uppercase tracking-widest">
                                正在審閱來自「{item.file.name}」的 {item.results.length} 筆提案
                              </p>
                            </div>
                            <div className="flex items-center gap-2 px-3 py-1 bg-white/60 rounded-lg border border-green-100">
                              <input 
                                type="checkbox"
                                checked={item.results.every(r => selectedProposalIds.has(r.id))}
                                onChange={() => toggleAllInFile(item.id)}
                                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              />
                              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider cursor-pointer">
                                全選
                              </label>
                            </div>
                          </div>
                          <p className="hidden sm:block text-[10px] text-slate-400 font-medium italic">
                            點擊按鈕加入，處理後檔案將自動從隊列清除
                          </p>
                        </div>
                        
                        <div className="p-4 max-h-[500px] overflow-y-auto custom-scrollbar space-y-3">
                          {item.results.map((p, i) => (
                            <div 
                              key={p.id} 
                              className={cn(
                                "p-4 rounded-xl border transition-all duration-200 flex items-center gap-4 group",
                                selectedProposalIds.has(p.id) 
                                  ? "bg-blue-50/30 border-blue-200 shadow-sm" 
                                  : "bg-white border-slate-200 hover:border-blue-100"
                              )}
                            >
                              <div className="flex-shrink-0">
                                <input 
                                  type="checkbox"
                                  checked={selectedProposalIds.has(p.id)}
                                  onChange={() => toggleProposalSelection(p.id)}
                                  className="w-5 h-5 rounded-md border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                />
                              </div>
                              <div className="flex-1 flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                      {p.meetingName}
                                    </span>
                                    <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                                      ID: {p.id}
                                    </span>
                                  </div>
                                  <h4 className="font-bold text-slate-900 text-sm mb-2">{p.title}</h4>
                                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-slate-500">
                                    <p><span className="font-semibold text-slate-400">單位：</span>{p.unit}</p>
                                    <p><span className="font-semibold text-slate-400">檔案：</span>{p.fileName}</p>
                                    <p><span className="font-semibold text-slate-400">頁碼：</span>{p.page ?? 'N/A'}</p>
                                  </div>
                                </div>
                                <button 
                                  onClick={() => setSelectedProposal(p)}
                                  className="px-3 py-1.5 text-[11px] font-bold text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-100 transition-colors whitespace-nowrap"
                                >
                                  View Details
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        
                        <div className="p-4 bg-white border-t border-green-100 flex justify-end gap-3">
                          <button 
                            onClick={() => confirmResults(item.id)}
                            className="px-4 py-2 text-slate-500 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all flex items-center gap-2"
                          >
                            全部加入
                          </button>
                          <button 
                            onClick={() => confirmResults(item.id, selectedProposalIds)}
                            disabled={selectedProposalIds.size === 0}
                            className={cn(
                              "px-6 py-2.5 text-white text-sm font-bold rounded-xl transition-all flex items-center gap-2 shadow-lg",
                              selectedProposalIds.size > 0 
                                ? "bg-green-600 hover:bg-green-700 shadow-green-100 hover:scale-[1.02] active:scale-[0.98]" 
                                : "bg-slate-300 translate-y-0 shadow-none cursor-not-allowed"
                            )}
                          >
                            <CheckCircle2 className="w-5 h-5" />
                            {selectedProposalIds.size > 0 
                              ? `確認加入所選 (${selectedProposalIds.size})` 
                              : "請先勾選項目"}
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Staging Area / Confirmed Results */}
        <section className="space-y-6">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div className="flex items-center gap-2">
              <Layers className="w-6 h-6 text-blue-600" />
              <h2 className="text-2xl font-bold text-slate-900">已確認提案清單</h2>
              <span className="bg-blue-100 text-blue-700 text-xs font-bold px-2.5 py-0.5 rounded-full">
                共 {confirmedResults.length} 筆
              </span>
            </div>
            
            {confirmedResults.length > 0 && (
              <div className="flex items-center bg-slate-100 p-1 rounded-lg">
                <button 
                  onClick={() => setViewMode("grid")}
                  className={cn(
                    "p-1.5 rounded-md transition-all",
                    viewMode === "grid" ? "bg-white shadow-sm text-blue-600" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setViewMode("list")}
                  className={cn(
                    "p-1.5 rounded-md transition-all",
                    viewMode === "list" ? "bg-white shadow-sm text-blue-600" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {confirmedResults.length > 0 ? (
            <div className="space-y-4">
              {sortedYears.map((year) => (
                <div key={year} className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
                  <button
                    onClick={() => toggleYear(year)}
                    className="w-full px-6 py-5 flex items-center justify-between hover:bg-slate-50 transition-colors group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center font-bold text-lg">
                        {year}
                      </div>
                      <div className="text-left">
                        <h3 className="text-xl font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                          {year === "其他" ? "其他年度" : `${year} 學年度`}
                        </h3>
                        <p className="text-sm text-slate-500 font-medium">
                          共有 {groupedResults[year].length} 筆提案
                        </p>
                      </div>
                    </div>
                    <div className={cn(
                      "w-10 h-10 rounded-full border border-slate-200 flex items-center justify-center text-slate-400 transition-transform duration-300",
                      expandedYears.has(year) ? "rotate-90 bg-blue-600 border-blue-600 text-white" : "rotate-0"
                    )}>
                      <ChevronRight className="w-5 h-5" />
                    </div>
                  </button>

                  <AnimatePresence>
                    {expandedYears.has(year) && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="p-6 pt-0 border-t border-slate-100 bg-slate-50/30">
                          <div className={cn(
                            "grid gap-6 mt-6",
                            viewMode === "grid" ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3" : "grid-cols-1"
                          )}>
                            {groupedResults[year].map((proposal, index) => (
                              <motion.div
                                key={proposal.id || index}
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                className={cn(
                                  "group bg-white rounded-2xl border shadow-sm hover:shadow-xl transition-all duration-300 overflow-hidden flex flex-col relative",
                                  selectedConfirmedIds.has(proposal.id) ? "border-blue-500 ring-2 ring-blue-500/20" : "border-slate-200 hover:border-blue-200"
                                )}
                              >
                                {/* Selection Checkbox */}
                                <div className="absolute top-4 left-4 z-10">
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleConfirmedSelection(proposal.id);
                                    }}
                                    className={cn(
                                      "w-5 h-5 rounded border transition-all flex items-center justify-center",
                                      selectedConfirmedIds.has(proposal.id) 
                                        ? "bg-blue-600 border-blue-600 text-white" 
                                        : "bg-white border-slate-300 group-hover:border-blue-400"
                                    )}
                                  >
                                    {selectedConfirmedIds.has(proposal.id) && <CheckCircle2 className="w-3.5 h-3.5" />}
                                  </button>
                                </div>

                                <div 
                                  className="p-6 flex-1 cursor-pointer"
                                  onClick={() => setSelectedProposal(proposal)}
                                >
                                  <div className="flex items-start justify-between mb-4 ml-8">
                                    <div className="flex flex-col gap-1">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1">
                                        <FileText className="w-2.5 h-2.5" />
                                        {proposal.meetingName}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded w-fit">
                                          ID: {proposal.id}
                                        </span>
                                        <span className="text-[10px] font-bold text-slate-400">
                                          Page: {proposal.page ?? 'N/A'}
                                        </span>
                                      </div>
                                    </div>
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); copyToClipboard(JSON.stringify(proposal, null, 2)); }}
                                      className="text-slate-400 hover:text-blue-600 transition-colors"
                                    >
                                      <Clipboard className="w-4 h-4" />
                                    </button>
                                  </div>
                                  
                                  <h3 className="text-lg font-bold text-slate-900 mb-3 line-clamp-2 group-hover:text-blue-600 transition-colors">
                                    {proposal.title}
                                  </h3>
                                  
                                  <div className="space-y-4 text-sm">
                                    <div>
                                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Unit</p>
                                      <p className="text-slate-700 font-medium">{proposal.unit}</p>
                                    </div>
                                    
                                    <div>
                                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Content</p>
                                      <div className="text-slate-600 line-clamp-3 prose prose-sm prose-slate">
                                        <Markdown>{proposal.content}</Markdown>
                                      </div>
                                    </div>

                                    <div>
                                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Result</p>
                                      <div className="text-slate-600 line-clamp-3 prose prose-sm prose-slate">
                                        <Markdown>{proposal.result}</Markdown>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                
                                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                                  <div className="flex items-center gap-2 text-xs text-slate-500">
                                    <FileCheck className="w-3 h-3 text-green-500" />
                                    已確認
                                  </div>
                                  <button 
                                    onClick={(e) => { e.stopPropagation(); setSelectedProposal(proposal); }}
                                    className="text-blue-600 text-xs font-bold flex items-center gap-1 hover:underline"
                                  >
                                    查看詳情
                                    <ChevronRight className="w-3 h-3" />
                                  </button>
                                </div>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-20 text-center bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 text-slate-300 mb-4">
                <Plus className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-1">目前尚無已確認的提案</h3>
              <p className="text-slate-500 max-w-xs mx-auto text-sm">
                處理上傳的檔案並點擊「確認加入」，即可建立合併的 JSON 資料。
              </p>
            </div>
          )}
        </section>

        {/* Archive History Section (Only if logged in) */}
        {user && (
          <section className="mt-12 pt-12 border-t border-slate-200">
            <div className="flex items-center gap-2 mb-6">
              <History className="w-6 h-6 text-slate-400" />
              <h2 className="text-2xl font-bold text-slate-900">雲端歸檔歷史</h2>
            </div>
            
            <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
              <div className="p-6 border-b border-slate-100 bg-slate-50/50">
                <p className="text-sm text-slate-500">
                  這裡記錄了每一次成功轉檔並確認加入的檔案批次。所有資料皆已同步至雲端存儲。
                </p>
              </div>
              <div className="divide-y divide-slate-100">
                {confirmedResults.length > 0 ? (
                  Array.from(new Set(confirmedResults.map(p => p.fileName))).map((fname, idx) => (
                    <div key={idx} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-green-50 text-green-600 rounded-lg flex items-center justify-center">
                          <FileCheck className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-900">{fname}</p>
                          <p className="text-[10px] text-slate-400 uppercase tracking-widest font-medium">
                            {confirmedResults.filter(p => p.fileName === fname).length} 筆提案
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="px-2 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded uppercase tracking-wider">
                          已同步
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-12 text-center text-slate-400 italic text-sm">
                    目前尚無雲端歸檔紀錄
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto py-12 border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-sm text-slate-400">
            © 2026 政大教務助手 • 由 Gemini AI 提供技術支援
          </p>
        </div>
      </footer>

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedProposal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedProposal(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-3xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between p-6 border-b border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      會議次別：{selectedProposal.meetingName} | 來源檔案：{selectedProposal.fileName} | 頁碼：{selectedProposal.page ?? '未知'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                        案號: {selectedProposal.id}
                      </span>
                      <h2 className="text-xl font-bold text-slate-900 line-clamp-1">提案詳情</h2>
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedProposal(null)}
                  className="p-2 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-8 space-y-8">
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">{selectedProposal.title}</h3>
                  <p className="text-slate-500 font-medium flex items-center gap-2">
                    <span className="w-2 h-2 bg-blue-500 rounded-full" />
                    {selectedProposal.unit}
                  </p>
                </div>

                <div className="grid gap-8 sm:grid-cols-2">
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest">內容/說明</h4>
                    <div className="prose prose-slate max-w-none text-slate-700">
                      <Markdown>{selectedProposal.content}</Markdown>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest">決議結果</h4>
                    <div className="prose prose-slate max-w-none text-slate-700">
                      <Markdown>{selectedProposal.result}</Markdown>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end gap-3">
                <button 
                  onClick={() => copyToClipboard(JSON.stringify(selectedProposal, null, 2))}
                  className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-white hover:shadow-sm rounded-xl transition-all flex items-center gap-2"
                >
                  <Clipboard className="w-4 h-4" />
                  複製 JSON
                </button>
                <button 
                  onClick={() => setSelectedProposal(null)}
                  className="px-6 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-lg shadow-blue-200 transition-all"
                >
                  關閉
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Message Modal */}
      <AnimatePresence>
        {msgModal.isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMsgModal(prev => ({ ...prev, isOpen: false }))}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
            >
              <div className="p-6">
                <div className={cn(
                  "w-12 h-12 rounded-2xl flex items-center justify-center mb-4",
                  msgModal.type === 'danger' ? "bg-red-50 text-red-600" : 
                  msgModal.type === 'success' ? "bg-green-50 text-green-600" :
                  "bg-blue-50 text-blue-600"
                )}>
                  {msgModal.type === 'danger' ? <Trash2 className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />}
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-2">{msgModal.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{msgModal.message}</p>
              </div>
              <div className="p-4 bg-slate-50 border-t border-slate-100 flex gap-3">
                {msgModal.onConfirm && (
                  <button
                    onClick={() => {
                      setMsgModal(prev => ({ ...prev, isOpen: false }));
                    }}
                    className="flex-1 px-4 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-xl transition-all"
                  >
                    {msgModal.cancelText}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (msgModal.onConfirm) msgModal.onConfirm();
                    setMsgModal(prev => ({ ...prev, isOpen: false }));
                  }}
                  className={cn(
                    "flex-1 px-4 py-2.5 text-sm font-bold text-white rounded-xl shadow-lg transition-all",
                    msgModal.type === 'danger' ? "bg-red-600 hover:bg-red-700 shadow-red-100" : "bg-blue-600 hover:bg-blue-700 shadow-blue-100"
                  )}
                >
                  {msgModal.confirmText}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
