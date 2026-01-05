import React, { useState, useEffect, useRef } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { jsPDF } from "jspdf";

// --- HELPERS ---
const compressImage = (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7)); 
      };
    };
  });
};

const loadImageForPDF = (url) => {
    return new Promise((resolve) => {
        const img = new Image();
        img.src = url;
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
    });
};

const NapkinCalculator = () => {
  const savedProperties = useLiveQuery(() => db.properties.toArray());
  const [showHistory, setShowHistory] = useState(false);
  const [images, setImages] = useState([]); 
  const [isCompressing, setIsCompressing] = useState(false);
  
  // Install & Modal State
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSettings, setShowSettings] = useState(false); // <--- NEW
  const [feedbackText, setFeedbackText] = useState('');
  const fileInputRef = useRef(null);

  // --- MODES: 'standard', 'reverse', 'refi' ---
  const [calcMode, setCalcMode] = useState('standard'); 

  // --- DEFAULTS (Loaded from LocalStorage on mount) ---
  const [defaults, setDefaults] = useState({
    downPaymentPercent: 20,
    interestRate: 7.5,
    taxes: 4500,
    insurance: 1200,
    hoa: 0,
    targetDscr: 1.25,
    ltvRefi: 75 // Specific for Refi mode (Cash out LTV)
  });

  const [values, setValues] = useState({
    address: '',
    notes: '',
    price: 350000, // Acts as "Appraised Value" in Refi mode
    existingDebt: 0, // NEW: For Refi Mode
    downPaymentPercent: 20,
    interestRate: 7.5,
    rent: 3200,
    taxes: 4500,
    insurance: 1200,
    hoa: 0,
    targetDscr: 1.25 
  });

  const [metrics, setMetrics] = useState({ 
    dscr: 0, 
    cashFlow: 0, 
    pitia: 0, 
    loanAmount: 0,
    maxOffer: 0,
    cashOut: 0 // NEW: For Refi Mode
  });

  // --- INIT: LOAD DEFAULTS ---
  useEffect(() => {
    const stored = localStorage.getItem('equicheck_defaults');
    if (stored) {
        const parsed = JSON.parse(stored);
        setDefaults(parsed);
        // Apply defaults to current inputs immediately
        setValues(prev => ({
            ...prev,
            downPaymentPercent: parsed.downPaymentPercent,
            interestRate: parsed.interestRate,
            taxes: parsed.taxes,
            insurance: parsed.insurance,
            hoa: parsed.hoa,
            targetDscr: parsed.targetDscr
        }));
    }
  }, []);

  // --- INSTALL LISTENER ---
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallClick = () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then((r) => { if (r.outcome === 'accepted') setInstallPrompt(null); });
  };

  const handleSendFeedback = () => {
    window.location.href = `mailto:kyle@adynton.com?subject=EquiCheck%20Feedback&body=${encodeURIComponent(feedbackText)}`;
    setShowFeedback(false); setFeedbackText('');
  };

  const saveSettings = () => {
    localStorage.setItem('equicheck_defaults', JSON.stringify(defaults));
    // Update current values to match new defaults
    setValues(prev => ({ ...prev, ...defaults }));
    setShowSettings(false);
    alert("Defaults Saved!");
  };

  const handleBackup = async () => {
    try {
        const data = await db.properties.toArray();
        const blob = new Blob([JSON.stringify(data)], {type: "application/json"});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `EquiCheck_Backup_${new Date().toISOString().slice(0,10)}.json`;
        link.click();
    } catch (err) { alert("Backup failed: " + err.message); }
  };

  const handleRestore = async (e) => {
    const file = e.target.files[0];
    if (!file || !window.confirm("Overwrite current data?")) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            await db.properties.clear();
            await db.properties.bulkAdd(JSON.parse(event.target.result));
            alert("Restored!");
        } catch { alert("Invalid file."); }
    };
    reader.readAsText(file);
  };

  // --- CORE MATH ---
  useEffect(() => {
    const monthlyRate = values.interestRate / 100 / 12;
    const n = 30 * 12;
    const fixedCosts = (values.taxes / 12) + (values.insurance / 12) + values.hoa;

    let dscr = 0, cashFlow = 0, pitia = 0, loanAmount = 0, maxOffer = 0, cashOut = 0;

    if (calcMode === 'standard') {
        loanAmount = values.price * (1 - values.downPaymentPercent / 100);
        const mortgage = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
        pitia = mortgage + fixedCosts;
        dscr = pitia > 0 ? values.rent / pitia : 0;
        cashFlow = values.rent - pitia;

    } else if (calcMode === 'reverse') {
        const maxPitia = values.rent / values.targetDscr;
        const maxMortgage = maxPitia - fixedCosts;
        if (maxMortgage > 0) {
            loanAmount = maxMortgage * (1 - Math.pow(1 + monthlyRate, -n)) / monthlyRate;
            maxOffer = loanAmount / ((100 - values.downPaymentPercent) / 100);
            pitia = maxPitia;
            dscr = values.targetDscr;
            cashFlow = values.rent - pitia;
        }
    } else if (calcMode === 'refi') {
        // REFI MATH (BRRRR)
        // Loan Amount is based on Appraised Value (Price) * Refi LTV
        // Refi LTV usually defaults to 75%
        loanAmount = values.price * (defaults.ltvRefi / 100);
        const mortgage = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
        pitia = mortgage + fixedCosts;
        dscr = pitia > 0 ? values.rent / pitia : 0;
        cashFlow = values.rent - pitia;
        // Cash Out = New Loan - Existing Debt
        cashOut = loanAmount - values.existingDebt;
    }

    setMetrics({ 
        dscr: parseFloat(dscr.toFixed(2)), 
        cashFlow: Math.round(cashFlow), 
        pitia: Math.round(pitia),
        loanAmount: Math.round(loanAmount),
        maxOffer: Math.round(maxOffer),
        cashOut: Math.round(cashOut)
    });
  }, [values, calcMode, defaults]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setValues({ ...values, [name]: (name === 'address' || name === 'notes') ? value : (parseFloat(value) || 0) });
  };
  
  const handleDefaultChange = (e) => {
    const { name, value } = e.target;
    setDefaults({ ...defaults, [name]: parseFloat(value) || 0 });
  };

  const handlePhotoCapture = async (e) => {
    if (e.target.files && e.target.files[0]) {
      setIsCompressing(true);
      const file = e.target.files[0];
      const compressedBase64 = await compressImage(file);
      setImages([...images, compressedBase64]);
      setIsCompressing(false);
    }
  };
  const removeImage = (idx) => setImages(images.filter((_, i) => i !== idx));

  // --- PDF GENERATOR ---
  const generatePDF = async () => {
    if (!values.address) { alert("Add an address first!"); return; }
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    let yPos = 20;

    const logoImg = await loadImageForPDF('/pwa-192x192.png');
    if (logoImg) { doc.addImage(logoImg, 'PNG', 20, 10, 20, 20); yPos = 35; }
    
    doc.setFontSize(22); doc.setTextColor(40);
    doc.text(calcMode === 'refi' ? "Refinance Analysis" : "EquiCheck Field Report", logoImg ? 45 : 20, logoImg ? 22 : 20);
    
    doc.setFontSize(16); doc.setTextColor(0);
    doc.text(values.address, 20, yPos); yPos += 15;

    doc.setFillColor(240, 240, 240);
    doc.rect(15, yPos - 5, pageWidth - 30, 35, 'F');
    
    if (calcMode === 'reverse') {
         doc.text("TARGET DSCR", 25, yPos + 5); doc.text("MAX OFFER PRICE", 85, yPos + 5);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(0, 150, 0); doc.text(`$${metrics.maxOffer.toLocaleString()}`, 85, yPos + 15);
    } else if (calcMode === 'refi') {
         doc.text("NEW DSCR", 25, yPos + 5); doc.text("CASH OUT", 85, yPos + 5);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(metrics.cashOut >= 0 ? 0 : 200, metrics.cashOut >= 0 ? 150 : 0, 0); 
         doc.text(`$${metrics.cashOut.toLocaleString()}`, 85, yPos + 15);
    } else {
         doc.text("DSCR SCORE", 25, yPos + 5); doc.text("CASH FLOW", 85, yPos + 5);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(0, 150, 0); doc.text(`$${metrics.cashFlow}`, 85, yPos + 15);
    }
    
    doc.save(`${values.address.replace(/\s+/g, '_')}_EquiCheck.pdf`);
  };

  const handleSave = async () => {
    if (!values.address) { alert("Address required!"); return; }
    try {
        const finalPrice = calcMode === 'reverse' ? metrics.maxOffer : values.price;
        await db.properties.add({
            address: values.address,
            price: finalPrice,
            rent: values.rent,
            dscr: metrics.dscr,
            images: images,
            notes: values.notes,
            fullData: values,
            created: new Date()
        });
        alert("Saved!");
    } catch (error) { console.error("Save failed:", error); }
  };

  const loadProperty = (prop) => {
    setValues({ ...prop.fullData, notes: prop.fullData.notes || '' });
    setImages(prop.images || []);
    setCalcMode('standard');
    setShowHistory(false);
  };

  const getScoreColor = (dscr) => {
    if (dscr >= 1.25) return 'text-green-400 border-green-400';
    if (dscr >= 1.0) return 'text-yellow-400 border-yellow-400';
    return 'text-red-500 border-red-500';
  };

  return (
    <div className="p-4 max-w-md mx-auto bg-gray-900 min-h-screen text-gray-100 font-mono flex flex-col relative">
      
      {/* FEEDBACK MODAL */}
      {showFeedback && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600">
                <h3 className="text-xl font-bold mb-4">Send Feedback</h3>
                <textarea className="w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm h-32 mb-4 focus:outline-none focus:border-blue-500" value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)}/>
                <div className="flex justify-end gap-3"><button onClick={() => setShowFeedback(false)} className="text-gray-400">Cancel</button><button onClick={handleSendFeedback} className="bg-blue-600 px-4 py-2 rounded">Send</button></div>
            </div>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600">
                <h3 className="text-xl font-bold mb-4">Global Defaults</h3>
                <div className="space-y-3 text-sm">
                    <div><label className="text-gray-400">Default Rate (%)</label><input type="number" name="interestRate" value={defaults.interestRate} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div><label className="text-gray-400">Default Purchase Down %</label><input type="number" name="downPaymentPercent" value={defaults.downPaymentPercent} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div><label className="text-gray-400">Default Refi LTV %</label><input type="number" name="ltvRefi" value={defaults.ltvRefi} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div><label className="text-gray-400">Est Taxes ($/yr)</label><input type="number" name="taxes" value={defaults.taxes} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div><label className="text-gray-400">Est Insurance ($/yr)</label><input type="number" name="insurance" value={defaults.insurance} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                </div>
                <div className="flex justify-end gap-3 mt-6">
                    <button onClick={() => setShowSettings(false)} className="text-gray-400">Cancel</button>
                    <button onClick={saveSettings} className="bg-blue-600 px-4 py-2 rounded font-bold">Save Defaults</button>
                </div>
            </div>
        </div>
      )}

      {/* HEADER */}
      <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-2">
        <div className="flex items-center gap-3">
            <img src="/pwa-192x192.png" alt="Logo" className="w-8 h-8 rounded" />
            <h1 className="text-xl font-bold">EquiCheck</h1>
        </div>
        <div className="flex items-center gap-2">
            {/* SETTINGS BUTTON */}
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-white">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
            </button>
            <button onClick={() => setShowFeedback(true)} className="p-2 text-gray-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg></button>
            <a href="https://cash.me/$stevenkyledenton" target="_blank" rel="noreferrer" className="p-2 text-pink-500 hover:text-pink-400"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" /></svg></a>
            {installPrompt && (<button onClick={handleInstallClick} className="bg-green-600 text-white px-2 py-1 rounded text-xs uppercase font-bold">Install</button>)}
        </div>
      </div>

      <div className="flex-grow">
          {!showHistory ? (
            <>
                <div className="flex gap-2 mb-4">
                     <input type="text" name="address" placeholder="Property Address" value={values.address} onChange={handleChange} className="flex-grow bg-gray-800 border-b-2 border-gray-600 focus:border-blue-500 p-2 text-lg outline-none"/>
                     <button onClick={() => setShowHistory(true)} className="text-xs bg-gray-800 px-3 py-1 rounded border border-gray-600 whitespace-nowrap">Load Saved</button>
                </div>

                {/* MODE TOGGLE */}
                <div className="flex bg-gray-800 p-1 rounded-lg mb-4">
                    <button onClick={() => setCalcMode('standard')} className={`flex-1 py-2 rounded text-[10px] sm:text-xs font-bold ${calcMode === 'standard' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>BUY</button>
                    <button onClick={() => setCalcMode('reverse')} className={`flex-1 py-2 rounded text-[10px] sm:text-xs font-bold ${calcMode === 'reverse' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>MAO</button>
                    <button onClick={() => setCalcMode('refi')} className={`flex-1 py-2 rounded text-[10px] sm:text-xs font-bold ${calcMode === 'refi' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>REFI</button>
                </div>

                {/* SCORE GAUGE */}
                <div className={`mb-6 p-4 border-2 rounded-xl text-center transition-colors ${getScoreColor(metrics.dscr)}`}>
                    {calcMode === 'standard' && (
                        <div className="flex justify-around items-center">
                            <div><div className="text-4xl font-bold">{metrics.dscr}</div><div className="text-xs uppercase">DSCR</div></div>
                            <div className="text-left text-sm text-gray-300"><div>Flow: ${metrics.cashFlow}</div><div>PITIA: ${metrics.pitia}</div></div>
                        </div>
                    )}
                    {calcMode === 'reverse' && (
                        <div className="flex flex-col items-center">
                            <div className="text-xs uppercase tracking-widest mb-1">Max Allowable Offer</div>
                            <div className="text-3xl font-bold text-white mb-2">${metrics.maxOffer.toLocaleString()}</div>
                            <div className="text-xs text-gray-300">To hit {values.targetDscr} DSCR</div>
                        </div>
                    )}
                    {calcMode === 'refi' && (
                        <div className="flex flex-col items-center">
                            <div className="text-xs uppercase tracking-widest mb-1">Est. Cash Out</div>
                            <div className={`text-4xl font-bold mb-2 ${metrics.cashOut >= 0 ? 'text-green-400' : 'text-red-500'}`}>${metrics.cashOut.toLocaleString()}</div>
                            <div className="text-xs text-gray-300">New DSCR: {metrics.dscr}</div>
                        </div>
                    )}
                </div>

                {/* FIELD NOTES & PHOTOS */}
                <div className="mb-6"><label className="text-xs text-gray-500 mb-1 block">Field Notes</label><textarea name="notes" value={values.notes} onChange={handleChange} placeholder="Notes..." className="w-full bg-gray-800 border border-gray-700 rounded p-3 text-sm h-20 focus:outline-none focus:border-blue-500" /></div>
                
                <div className="mb-6 bg-gray-800 p-4 rounded-lg">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="text-gray-400 text-sm font-bold uppercase">Photos ({images.length})</h3>
                        <label className="text-blue-400 text-xs font-bold cursor-pointer uppercase">+ Add<input type="file" accept="image/*" capture="environment" onChange={handlePhotoCapture} className="hidden" disabled={isCompressing} /></label>
                    </div>
                    <div className="flex gap-2 overflow-x-auto">{images.map((imgSrc, idx) => (<div key={idx} className="relative flex-shrink-0"><img src={imgSrc} alt="Prop" className="h-16 w-16 object-cover rounded" /><button onClick={() => removeImage(idx)} className="absolute -top-1 -right-1 bg-red-600 rounded-full w-4 h-4 flex items-center justify-center text-[10px]">x</button></div>))}</div>
                </div>

                {/* INPUTS (DYNAMIC BASED ON MODE) */}
                <div className="space-y-4 text-sm mb-20">
                    <div className="grid grid-cols-2 gap-4">
                        {calcMode === 'standard' && (
                             <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        )}
                        {calcMode === 'reverse' && (
                             <div><label className="text-blue-400 font-bold">Target DSCR</label><input type="number" name="targetDscr" value={values.targetDscr} onChange={handleChange} className="w-full bg-gray-800 border border-blue-500 p-2 rounded"/></div>
                        )}
                        {calcMode === 'refi' && (
                             <div><label className="text-purple-400 font-bold">Appraised Value</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 border border-purple-500 p-2 rounded"/></div>
                        )}
                        
                        <div><label className="text-gray-500">Rent</label><input type="number" name="rent" value={values.rent} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>

                        {/* REFI SPECIFIC INPUT */}
                        {calcMode === 'refi' && (
                             <div className="col-span-2"><label className="text-gray-500">Existing Debt (Hard Money/Cash)</label><input type="number" name="existingDebt" value={values.existingDebt} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        )}
                        
                        <div><label className="text-gray-500">Rate (%)</label><input type="number" name="interestRate" value={values.interestRate} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        <div><label className="text-gray-500">Tax/Yr</label><input type="number" name="taxes" value={values.taxes} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        <div><label className="text-gray-500">Ins/Yr</label><input type="number" name="insurance" value={values.insurance} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        <div><label className="text-gray-500">HOA/Mo</label><input type="number" name="hoa" value={values.hoa} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                    </div>
                </div>

                <div className="fixed bottom-6 right-6 flex gap-3 z-40">
                    {values.address && (<button onClick={generatePDF} className="bg-gray-700 hover:bg-gray-600 text-white p-4 rounded-full shadow-lg font-bold">📄</button>)}
                    <button onClick={handleSave} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-4 rounded-full shadow-lg font-bold shadow-blue-900/50">SAVE</button>
                </div>
            </>
          ) : (
            <>
                <div className="flex justify-end mb-4"><button onClick={() => setShowHistory(false)} className="text-xs bg-gray-800 px-3 py-1 rounded border border-gray-600">Close List</button></div>
                <div className="space-y-2 mb-8">
                    {savedProperties?.map((prop) => (<div key={prop.id} onClick={() => loadProperty(prop)} className="bg-gray-800 p-4 rounded-lg flex justify-between cursor-pointer hover:bg-gray-700"><div><div className="font-bold">{prop.address}</div><div className="text-xs text-gray-400">{prop.images?.length || 0} Photos</div></div><div className={`font-bold ${getScoreColor(prop.dscr).split(' ')[0]}`}>{prop.dscr}</div></div>))}
                </div>
                <div className="border-t border-gray-700 pt-6"><h3 className="text-xs font-bold text-gray-500 uppercase mb-4">Data Management</h3><div className="flex gap-4"><button onClick={handleBackup} className="flex-1 bg-gray-700 py-3 rounded text-sm hover:bg-gray-600">⬇️ Backup</button><button onClick={() => fileInputRef.current.click()} className="flex-1 bg-gray-700 py-3 rounded text-sm hover:bg-gray-600">⬆️ Restore</button><input type="file" ref={fileInputRef} onChange={handleRestore} accept=".json" className="hidden" /></div></div>
            </>
          )}
      </div>

      <div className="mt-12 mb-20 pt-6 border-t border-gray-800 text-center">
        <p className="text-xs text-gray-600">&copy; 2026 Adynton Enterprises, LLC. All Rights Reserved.</p>
      </div>

    </div>
  );
};

export default NapkinCalculator;