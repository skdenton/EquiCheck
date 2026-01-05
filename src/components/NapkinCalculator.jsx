import React, { useState, useEffect, useRef } from 'react';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import { jsPDF } from "jspdf";

// --- HELPERS ---
const compressImage = (f) => {
  return new Promise((resolve) => {
    const r = new FileReader(); r.readAsDataURL(f);
    r.onload = (e) => {
      const i = new Image(); i.src = e.target.result;
      i.onload = () => {
        const c = document.createElement('canvas');
        const s = 800 / i.width; c.width = 800; c.height = i.height * s;
        c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7)); 
      };
    };
  });
};

const loadImageForPDF = (url) => {
    return new Promise((resolve) => {
        const i = new Image(); i.src = url;
        i.onload = () => resolve(i); i.onerror = () => resolve(null);
    });
};

const NapkinCalculator = () => {
  const savedProperties = useLiveQuery(() => db.properties.toArray());
  const [showHistory, setShowHistory] = useState(false);
  const [images, setImages] = useState([]); 
  const [isCompressing, setIsCompressing] = useState(false);
  
  // UI State
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const fileInputRef = useRef(null);

  // --- MODES ---
  const [calcMode, setCalcMode] = useState('standard'); 
  const [isItemized, setIsItemized] = useState(false);
  const [isPartnership, setIsPartnership] = useState(false); // NEW: Partnership Toggle

  // --- DEFAULTS ---
  const [defaults, setDefaults] = useState({
    taxes: 4500, insurance: 1200, hoa: 0,
    targetDscr: 1.25, vacancy: 5, expenseRatio: 35, 
    mgmt: 5, maint: 5, utils: 0,
    primaryRate: 7.5, primaryLtv: 80
  });

  // --- CAPITAL STACK ---
  const [loans, setLoans] = useState([
    { id: 1, name: 'Senior Debt', ltv: 80, rate: 7.5, isIO: false }
  ]);

  const [values, setValues] = useState({
    address: '', notes: '',
    price: 350000, existingDebt: 0,
    rent: 3200, grossAnnual: 0, 
    taxes: 4500, insurance: 1200, hoa: 0,
    vacancy: 5, expenseRatio: 35,
    mgmt: 5, maint: 5, utils: 0,
    targetDscr: 1.25,
    // Partnership Specifics
    investorEquity: 50, // % ownership for investor
    investorCapital: 100 // % of cash needed provided by investor
  });

  const [metrics, setMetrics] = useState({ 
    dscr: 0, cashFlow: 0, pitia: 0, totalLoanAmount: 0, 
    maxOffer: 0, cashOut: 0,
    capRate: 0, noi: 0, coc: 0,
    blendedRate: 0, cltv: 0,
    // Partnership Metrics
    investorFlow: 0, sponsorFlow: 0, investorCoc: 0, sponsorCoc: 0
  });

  // --- INIT ---
  useEffect(() => {
    const stored = localStorage.getItem('equicheck_defaults');
    if (stored) {
        const p = JSON.parse(stored);
        setDefaults(p);
        setValues(prev => ({ ...prev, ...p }));
        setLoans([{ id: 1, name: 'Senior Debt', ltv: p.primaryLtv || 80, rate: p.primaryRate || 7.5, isIO: false }]);
    }
  }, []);

  useEffect(() => {
     if (values.grossAnnual === 0 && values.rent > 0) {
         setValues(prev => ({...prev, grossAnnual: prev.rent * 12}));
     }
  }, []);

  // --- LISTENERS ---
  useEffect(() => {
    const h = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
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
    setShowSettings(false);
  };

  const handleBackup = async () => {
    try {
        const d = await db.properties.toArray();
        const b = new Blob([JSON.stringify(d)], {type: "application/json"});
        const l = document.createElement('a');
        l.href = URL.createObjectURL(b);
        l.download = `EquiCheck_Backup_${new Date().toISOString().slice(0,10)}.json`;
        l.click();
    } catch (e) { alert("Backup failed: " + e.message); }
  };

  const handleRestore = async (e) => {
    const f = e.target.files[0];
    if (!f || !window.confirm("Overwrite current data?")) return;
    const r = new FileReader();
    r.onload = async (ev) => {
        try { await db.properties.clear(); await db.properties.bulkAdd(JSON.parse(ev.target.result)); alert("Restored!"); } 
        catch { alert("Invalid file."); }
    };
    r.readAsText(f);
  };

  // --- LOAN MANAGEMENT ---
  const updateLoan = (id, field, value) => setLoans(loans.map(l => l.id === id ? { ...l, [field]: value } : l));
  const addLoan = () => setLoans([...loans, { id: loans.length > 0 ? Math.max(...loans.map(l => l.id)) + 1 : 1, name: 'Sub Debt', ltv: 10, rate: 10, isIO: true }]);
  const removeLoan = (id) => { if (loans.length > 1) setLoans(loans.filter(l => l.id !== id)); };

  // --- CORE MATH ENGINE ---
  useEffect(() => {
    const v = (key) => (values[key] === '' || values[key] === undefined) ? 0 : parseFloat(values[key]);
    const price = v('price');
    const monthlyGross = calcMode === 'cre' ? (v('grossAnnual') / 12) : v('rent');
    
    let monthlyExpenses = 0;
    let fixedCosts = (v('taxes') / 12) + (v('insurance') / 12) + v('hoa');

    if (calcMode === 'cre') {
        const vacancyLoss = monthlyGross * (v('vacancy') / 100);
        if (isItemized) {
            monthlyExpenses = (v('taxes')/12) + (v('insurance')/12) + (monthlyGross * (v('mgmt')/100)) + (monthlyGross * (v('maint')/100)) + v('utils') + vacancyLoss;
        } else {
            monthlyExpenses = monthlyGross * (v('expenseRatio') / 100);
        }
    } else {
        monthlyExpenses = fixedCosts;
    }

    let dscr=0, cashFlow=0, pitia=0, totalLoanAmount=0, maxOffer=0, cashOut=0, capRate=0, noi=0, coc=0, totalDebtService=0, blendedRate=0;

    // --- DEBT CALCULATION ---
    if (calcMode === 'reverse') {
        const primary = loans[0];
        const mRate = primary.rate / 100 / 12;
        const n = 30 * 12;
        const maxPitia = monthlyGross / v('targetDscr');
        const maxDebtPayment = maxPitia - fixedCosts;
        
        if (maxDebtPayment > 0) {
            let calculatedLoan = 0;
            if (primary.isIO) calculatedLoan = maxDebtPayment / mRate;
            else calculatedLoan = maxDebtPayment * (1 - Math.pow(1 + mRate, -n)) / mRate;
            maxOffer = calculatedLoan / (primary.ltv / 100);
            pitia = maxPitia;
            dscr = v('targetDscr');
            cashFlow = monthlyGross - pitia;
        }
    } else {
        let weightedRateSum = 0;
        loans.forEach(loan => {
            const amt = price * (loan.ltv / 100);
            totalLoanAmount += amt;
            weightedRateSum += (amt * loan.rate);
            const r = loan.rate / 100 / 12;
            let pmt = 0;
            if (loan.isIO) pmt = amt * r;
            else { const n = 30 * 12; pmt = r > 0 ? amt * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : 0; }
            totalDebtService += pmt;
        });

        blendedRate = totalLoanAmount > 0 ? (weightedRateSum / totalLoanAmount) : 0;
        const totalOutflow = totalDebtService + monthlyExpenses;
        pitia = totalOutflow;
        cashFlow = monthlyGross - totalOutflow;
        dscr = totalOutflow > 0 ? monthlyGross / totalOutflow : 0;

        if (calcMode === 'refi') cashOut = totalLoanAmount - v('existingDebt');

        noi = (monthlyGross - monthlyExpenses) * 12;
        capRate = price > 0 ? (noi / price) * 100 : 0;
        const cashInvested = price - totalLoanAmount; 
        coc = cashInvested > 0 ? ((cashFlow * 12) / cashInvested) * 100 : 0;
    }

    // --- PARTNERSHIP MATH ---
    // Total Cash Required = Price - TotalLoans (simplified, ignoring closing costs for napkin)
    const totalCashRequired = Math.max(0, price - totalLoanAmount);
    
    // Investor Side
    const investorCashIn = totalCashRequired * (v('investorCapital') / 100);
    const investorFlow = cashFlow * (v('investorEquity') / 100);
    // Avoid div by zero. If Investor puts 0 cash but gets flow, return is Infinite (9999)
    const investorCoc = investorCashIn > 0 ? ((investorFlow * 12) / investorCashIn) * 100 : (investorFlow > 0 ? 9999 : 0);

    // Sponsor Side
    const sponsorCashIn = totalCashRequired * ((100 - v('investorCapital')) / 100);
    const sponsorFlow = cashFlow * ((100 - v('investorEquity')) / 100);
    const sponsorCoc = sponsorCashIn > 0 ? ((sponsorFlow * 12) / sponsorCashIn) * 100 : (sponsorFlow > 0 ? 9999 : 0);

    setMetrics({ 
        dscr: parseFloat(dscr.toFixed(2)), 
        cashFlow: Math.round(cashFlow), 
        pitia: Math.round(pitia), 
        totalLoanAmount: Math.round(totalLoanAmount),
        maxOffer: Math.round(maxOffer), 
        cashOut: Math.round(cashOut),
        capRate: parseFloat(capRate.toFixed(2)), 
        noi: Math.round(noi), 
        coc: parseFloat(coc.toFixed(2)),
        blendedRate: parseFloat(blendedRate.toFixed(3)),
        cltv: loans.reduce((sum, l) => sum + l.ltv, 0),
        investorFlow: Math.round(investorFlow),
        sponsorFlow: Math.round(sponsorFlow),
        investorCoc: parseFloat(investorCoc.toFixed(1)),
        sponsorCoc: parseFloat(sponsorCoc.toFixed(1))
    });

  }, [values, calcMode, isItemized, loans]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    const finalVal = (name === 'address' || name === 'notes') ? value : (value === '' ? '' : parseFloat(value));
    setValues({ ...values, [name]: finalVal });
  };
  
  const handleDefaultChange = (e) => {
    const { name, value } = e.target;
    setDefaults({ ...defaults, [name]: value === '' ? '' : parseFloat(value) });
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

  // --- PDF ---
  const generatePDF = async () => {
    if (!values.address) { alert("Add an address first!"); return; }
    const doc = new jsPDF();
    let yPos = 20;

    const logoImg = await loadImageForPDF('/pwa-192x192.png');
    if (logoImg) { doc.addImage(logoImg, 'PNG', 20, 10, 20, 20); yPos = 35; }
    
    doc.setFontSize(22); doc.setTextColor(40);
    const title = calcMode === 'cre' ? "CRE Investment Analysis" : (calcMode === 'refi' ? "Refinance Analysis" : "EquiCheck Field Report");
    doc.text(title, logoImg ? 45 : 20, logoImg ? 22 : 20);
    doc.setFontSize(16); doc.setTextColor(0);
    doc.text(values.address, 20, yPos); yPos += 15;

    doc.setFillColor(240, 240, 240);
    doc.rect(15, yPos - 5, 180, 35, 'F');
    
    if (calcMode === 'cre') {
        doc.text("CAP RATE", 25, yPos + 5); doc.text("NOI (Annual)", 85, yPos + 5); doc.text("Cash-on-Cash", 145, yPos + 5);
        doc.setTextColor(0, 0, 255); doc.text(metrics.capRate + "%", 25, yPos + 15);
        doc.setTextColor(0, 150, 0); doc.text(`$${metrics.noi.toLocaleString()}`, 85, yPos + 15);
        doc.setTextColor(0, 0, 0); doc.text(metrics.coc + "%", 145, yPos + 15);
    } else {
         doc.text("DSCR SCORE", 25, yPos + 5); doc.text("CASH FLOW", 85, yPos + 5);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(0, 150, 0); doc.text(`$${metrics.cashFlow}`, 85, yPos + 15);
    }
    
    yPos += 45;
    doc.setTextColor(0); doc.setFontSize(12);
    doc.text("Capital Stack", 20, yPos); yPos += 10;
    doc.setFontSize(10);
    loans.forEach(l => {
        doc.text(`${l.name}: ${l.ltv}% LTV @ ${l.rate}% ${l.isIO ? '(IO)' : ''}`, 20, yPos);
        yPos += 6;
    });
    doc.text(`Blended Rate: ${metrics.blendedRate}% | CLTV: ${metrics.cltv}%`, 20, yPos + 2);
    yPos += 10;

    if (isPartnership) {
        doc.setFontSize(12); doc.text("Partnership Structure", 20, yPos); yPos += 10;
        doc.setFontSize(10);
        doc.text(`Investor: ${values.investorEquity}% Equity / ${values.investorCapital}% Capital`, 20, yPos);
        doc.text(`Sponsor: ${100-values.investorEquity}% Equity / ${100-values.investorCapital}% Capital`, 20, yPos + 6);
        doc.setTextColor(0,150,0);
        doc.text(`Investor Return: ${metrics.investorCoc >= 9999 ? '∞' : metrics.investorCoc + '%'} CoC ($${metrics.investorFlow}/mo)`, 20, yPos + 14);
        doc.setTextColor(0);
        yPos += 25;
    }
    
    doc.save(`${values.address.replace(/\s+/g, '_')}_EquiCheck.pdf`);
  };

  const handleSave = async () => {
    if (!values.address) { alert("Address required!"); return; }
    try {
        const finalPrice = calcMode === 'reverse' ? metrics.maxOffer : values.price;
        await db.properties.add({
            address: values.address, price: finalPrice, rent: values.rent, dscr: metrics.dscr,
            images: images, notes: values.notes, fullData: values, loans: loans, created: new Date()
        });
        alert("Saved!");
    } catch (e) { console.error(e); }
  };

  const loadProperty = (prop) => {
    setValues({ ...prop.fullData, notes: prop.fullData.notes || '' });
    if (prop.loans && prop.loans.length > 0) {
        setLoans(prop.loans);
    } else {
        // LEGACY SAVE SUPPORT (V1.0)
        const oldLtv = 100 - (prop.fullData.downPaymentPercent || 20);
        const oldRate = prop.fullData.interestRate || 7.5;
        setLoans([{ id: 1, name: 'Senior Debt', ltv: oldLtv, rate: oldRate, isIO: false }]);
    }
    setImages(prop.images || []); setCalcMode('standard'); setShowHistory(false);
  };

  const getScoreColor = (dscr) => {
    if (dscr >= 1.25) return 'text-green-400 border-green-400';
    if (dscr >= 1.0) return 'text-yellow-400 border-yellow-400';
    return 'text-red-500 border-red-500';
  };

  return (
    <div className="p-4 max-w-md mx-auto bg-gray-900 min-h-screen text-gray-100 font-mono flex flex-col relative">
      
      {/* MODALS */}
      {showFeedback && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600">
                <h3 className="text-xl font-bold mb-4">Send Feedback</h3>
                <textarea className="w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm h-32 mb-4 focus:outline-none focus:border-blue-500" value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)}/>
                <div className="flex justify-end gap-3"><button onClick={() => setShowFeedback(false)} className="text-gray-400">Cancel</button><button onClick={handleSendFeedback} className="bg-blue-600 px-4 py-2 rounded">Send</button></div>
            </div>
        </div>
      )}
      {showSettings && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600 max-h-[80vh] overflow-y-auto">
                <h3 className="text-xl font-bold mb-4">Global Defaults</h3>
                <div className="space-y-3 text-sm">
                    <div><label className="text-gray-400">Primary Rate (%)</label><input type="number" name="primaryRate" value={defaults.primaryRate} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div><label className="text-gray-400">Primary LTV %</label><input type="number" name="primaryLtv" value={defaults.primaryLtv} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                    <div className="pt-2 border-t border-gray-700 font-bold text-gray-500">CRE Defaults</div>
                    <div><label className="text-gray-400">Expense Ratio (%)</label><input type="number" name="expenseRatio" value={defaults.expenseRatio} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700"/></div>
                </div>
                <div className="flex justify-end gap-3 mt-6"><button onClick={() => setShowSettings(false)} className="text-gray-400">Cancel</button><button onClick={saveSettings} className="bg-blue-600 px-4 py-2 rounded font-bold">Save Defaults</button></div>
            </div>
        </div>
      )}

      {/* HEADER */}
      <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-2">
        <div className="flex items-center gap-3"><img src="/pwa-192x192.png" alt="Logo" className="w-8 h-8 rounded" /><h1 className="text-xl font-bold">EquiCheck</h1></div>
        <div className="flex items-center gap-2">
            <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg></button>
            <button onClick={() => setShowFeedback(true)} className="p-2 text-gray-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg></button>
            <a href="https://cash.me/$adynton" target="_blank" rel="noreferrer" className="p-2 text-pink-500 hover:text-pink-400"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" /></svg></a>
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

                <div className="flex bg-gray-800 p-1 rounded-lg mb-4">
                    {['standard', 'reverse', 'refi', 'cre'].map(m => (
                        <button key={m} onClick={() => setCalcMode(m)} className={`flex-1 py-2 rounded text-[10px] sm:text-xs font-bold uppercase ${calcMode === m ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>
                            {m === 'standard' ? 'Buy' : m === 'reverse' ? 'MAO' : m}
                        </button>
                    ))}
                </div>

                {/* SCORE GAUGE */}
                <div className={`mb-6 p-4 border-2 rounded-xl text-center transition-colors ${getScoreColor(metrics.dscr)}`}>
                    {calcMode === 'cre' ? (
                         <div className="flex justify-around items-center">
                            <div><div className="text-4xl font-bold">{metrics.capRate}%</div><div className="text-xs uppercase">CAP RATE</div></div>
                            <div className="text-left text-sm text-gray-300"><div>NOI: ${metrics.noi.toLocaleString()}</div><div>CoC: {metrics.coc}%</div></div>
                        </div>
                    ) : calcMode === 'reverse' ? (
                        <div className="flex flex-col items-center">
                            <div className="text-xs uppercase tracking-widest mb-1">Max Allowable Offer</div>
                            <div className="text-3xl font-bold text-white mb-2">${metrics.maxOffer.toLocaleString()}</div>
                            <div className="text-xs text-gray-300">To hit {values.targetDscr} DSCR</div>
                        </div>
                    ) : (
                        <div className="flex justify-around items-center">
                            <div><div className="text-4xl font-bold">{metrics.dscr}</div><div className="text-xs uppercase">DSCR</div></div>
                            <div className="text-left text-sm text-gray-300"><div>Flow: ${metrics.cashFlow}</div><div>PITIA: ${metrics.pitia}</div></div>
                        </div>
                    )}
                </div>

                {/* PHOTOS & NOTES */}
                <div className="mb-6"><label className="text-xs text-gray-500 mb-1 block">Field Notes</label><textarea name="notes" value={values.notes} onChange={handleChange} placeholder="Notes..." className="w-full bg-gray-800 border border-gray-700 rounded p-3 text-sm h-20 focus:outline-none focus:border-blue-500" /></div>
                <div className="mb-6 bg-gray-800 p-4 rounded-lg">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="text-gray-400 text-sm font-bold uppercase">Photos ({images.length})</h3>
                        <label className="text-blue-400 text-xs font-bold cursor-pointer uppercase">+ Add<input type="file" accept="image/*" capture="environment" onChange={handlePhotoCapture} className="hidden" disabled={isCompressing} /></label>
                    </div>
                    <div className="flex gap-2 overflow-x-auto">{images.map((imgSrc, idx) => (<div key={idx} className="relative flex-shrink-0"><img src={imgSrc} alt="Prop" className="h-16 w-16 object-cover rounded" /><button onClick={() => removeImage(idx)} className="absolute -top-1 -right-1 bg-red-600 rounded-full w-4 h-4 flex items-center justify-center text-[10px]">x</button></div>))}</div>
                </div>

                {/* INPUTS */}
                <div className="space-y-4 text-sm mb-20">
                    <div className="grid grid-cols-2 gap-4">
                        {calcMode === 'standard' && <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>}
                        {calcMode === 'reverse' && <div><label className="text-blue-400 font-bold">Target DSCR</label><input type="number" name="targetDscr" value={values.targetDscr} onChange={handleChange} className="w-full bg-gray-800 border border-blue-500 p-2 rounded"/></div>}
                        {calcMode === 'refi' && <div><label className="text-purple-400 font-bold">Appraised Value</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 border border-purple-500 p-2 rounded"/></div>}
                        {calcMode === 'cre' && <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>}
                        
                        {calcMode === 'cre' ? (
                             <div><label className="text-green-400 font-bold">Gross Annual Inc</label><input type="number" name="grossAnnual" value={values.grossAnnual} onChange={handleChange} className="w-full bg-gray-800 border border-green-500 p-2 rounded"/></div>
                        ) : (
                             <div><label className="text-gray-500">Rent (Monthly)</label><input type="number" name="rent" value={values.rent} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        )}
                    </div>
                    {calcMode === 'refi' && <div><label className="text-gray-500">Existing Debt</label><input type="number" name="existingDebt" value={values.existingDebt} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>}

                    {/* CRE EXPENSES */}
                    {calcMode === 'cre' && (
                        <div className="bg-gray-800 p-3 rounded-lg space-y-4 border border-gray-700">
                             <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold uppercase text-gray-400">Expenses</label>
                                <button onClick={() => setIsItemized(!isItemized)} className="text-[10px] bg-gray-700 px-2 py-1 rounded hover:bg-gray-600">{isItemized ? 'Switch to Ratio' : 'Switch to Itemized'}</button>
                             </div>
                             <div><div className="flex justify-between text-xs text-gray-400 mb-1"><span>Vacancy</span><span className="text-yellow-400 font-bold">{values.vacancy}%</span></div><input type="range" name="vacancy" min="0" max="20" step="1" value={values.vacancy} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" /></div>
                             {!isItemized ? (
                                <div><div className="flex justify-between text-xs text-gray-400 mb-1"><span>Expense Ratio</span><span className="text-red-400 font-bold">{values.expenseRatio}%</span></div><input type="range" name="expenseRatio" min="10" max="60" step="1" value={values.expenseRatio} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" /></div>
                             ) : (
                                <div className="grid grid-cols-3 gap-2">
                                    <div><label className="text-gray-500 text-xs">Mgmt %</label><input type="number" name="mgmt" value={values.mgmt} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded"/></div>
                                    <div><label className="text-gray-500 text-xs">Maint %</label><input type="number" name="maint" value={values.maint} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded"/></div>
                                    <div><label className="text-gray-500 text-xs">Util ($/mo)</label><input type="number" name="utils" value={values.utils} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded"/></div>
                                    <div><label className="text-gray-500 text-xs">Tax/Yr</label><input type="number" name="taxes" value={values.taxes} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded"/></div>
                                    <div><label className="text-gray-500 text-xs">Ins/Yr</label><input type="number" name="insurance" value={values.insurance} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded"/></div>
                                </div>
                             )}
                        </div>
                    )}

                    {/* CAPITAL STACK */}
                    {calcMode !== 'reverse' && (
                    <div className="bg-gray-800 p-3 rounded-lg space-y-4 border border-blue-900/50">
                        <div className="flex justify-between items-center border-b border-gray-700 pb-2">
                             <h3 className="text-xs font-bold uppercase text-blue-400">Capital Stack</h3>
                             <div className="text-[10px] text-gray-400">CLTV: <span className="text-white">{metrics.cltv}%</span></div>
                        </div>
                        {loans.map((loan, idx) => (
                            <div key={loan.id} className="bg-gray-900 p-2 rounded relative">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-xs font-bold text-gray-300">{loan.name}</span>
                                    {loans.length > 1 && (<button onClick={() => removeLoan(loan.id)} className="text-red-500 text-xs font-bold">X</button>)}
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-xs">
                                    <div><label className="text-gray-500 block">LTV %</label><input type="number" value={loan.ltv} onChange={(e) => updateLoan(loan.id, 'ltv', parseFloat(e.target.value))} className="w-full bg-gray-800 p-1 rounded"/></div>
                                    <div><label className="text-gray-500 block">Rate %</label><input type="number" value={loan.rate} onChange={(e) => updateLoan(loan.id, 'rate', parseFloat(e.target.value))} className="w-full bg-gray-800 p-1 rounded"/></div>
                                    <div className="flex items-center justify-center pt-4"><label className="flex items-center cursor-pointer gap-2"><input type="checkbox" checked={loan.isIO} onChange={(e) => updateLoan(loan.id, 'isIO', e.target.checked)} className="rounded bg-gray-700"/><span className="text-[10px] text-gray-400">IO Only</span></label></div>
                                </div>
                                {idx === 0 && (<div className="mt-2"><input type="range" min="0" max="100" value={loan.ltv} onChange={(e) => updateLoan(loan.id, 'ltv', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer" /></div>)}
                            </div>
                        ))}
                        <button onClick={addLoan} className="w-full py-2 bg-gray-700 hover:bg-gray-600 rounded text-xs font-bold text-gray-300">+ Add Source</button>
                    </div>
                    )}

                    {/* RES FIXED COSTS */}
                    {calcMode !== 'cre' && (
                        <div className="grid grid-cols-3 gap-2">
                            <div><label className="text-gray-500 text-xs">Tax/Yr</label><input type="number" name="taxes" value={values.taxes} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                            <div><label className="text-gray-500 text-xs">Ins/Yr</label><input type="number" name="insurance" value={values.insurance} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                            <div><label className="text-gray-500 text-xs">HOA/Mo</label><input type="number" name="hoa" value={values.hoa} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        </div>
                    )}

                    {/* PARTNERSHIP SECTION (NEW) */}
                    <div className="bg-gray-800 p-3 rounded-lg border border-purple-900/50">
                        <div className="flex items-center justify-between mb-2">
                             <h3 className="text-xs font-bold uppercase text-purple-400">Partnership Split</h3>
                             <label className="flex items-center cursor-pointer relative"><input type="checkbox" checked={isPartnership} onChange={() => setIsPartnership(!isPartnership)} className="sr-only peer"/><div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div></label>
                        </div>
                        
                        {isPartnership && (
                            <div className="space-y-4">
                                <div>
                                    <div className="flex justify-between text-xs text-gray-400 mb-1"><span>Investor Ownership</span><span className="text-purple-400 font-bold">{values.investorEquity}%</span></div>
                                    <input type="range" name="investorEquity" min="0" max="100" step="5" value={values.investorEquity} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                                    <div className="text-[10px] text-gray-500 text-right">You own {100-values.investorEquity}%</div>
                                </div>
                                <div>
                                    <div className="flex justify-between text-xs text-gray-400 mb-1"><span>Investor Capital</span><span className="text-green-400 font-bold">{values.investorCapital}%</span></div>
                                    <input type="range" name="investorCapital" min="0" max="100" step="5" value={values.investorCapital} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                                    <div className="text-[10px] text-gray-500 text-right">You put {100-values.investorCapital}%</div>
                                </div>
                                
                                <div className="grid grid-cols-2 gap-2 mt-2">
                                    <div className="bg-gray-900 p-2 rounded text-center">
                                        <div className="text-[10px] text-gray-400 uppercase">Investor CoC</div>
                                        <div className="text-xl font-bold text-green-400">{metrics.investorCoc >= 9999 ? '∞' : metrics.investorCoc + '%'}</div>
                                        <div className="text-[10px] text-gray-500">${metrics.investorFlow}/mo</div>
                                    </div>
                                    <div className="bg-gray-900 p-2 rounded text-center">
                                        <div className="text-[10px] text-gray-400 uppercase">Sponsor CoC</div>
                                        <div className="text-xl font-bold text-blue-400">{metrics.sponsorCoc >= 9999 ? '∞' : metrics.sponsorCoc + '%'}</div>
                                        <div className="text-[10px] text-gray-500">${metrics.sponsorFlow}/mo</div>
                                    </div>
                                </div>
                            </div>
                        )}
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

      <div className="mt-12 mb-20 pt-6 border-t border-gray-800 text-center"><p className="text-xs text-gray-600">&copy; 2026 Adynton Enterprises, LLC. All Rights Reserved.</p></div>
    </div>
  );
};

export default NapkinCalculator;