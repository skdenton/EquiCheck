import React, { useState, useEffect } from 'react';
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
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');

  // --- NEW: CALCULATION MODE ---
  const [calcMode, setCalcMode] = useState('standard'); // 'standard' or 'reverse'

  const [values, setValues] = useState({
    address: '',
    notes: '',
    price: 350000,
    downPaymentPercent: 20,
    interestRate: 7.5,
    rent: 3200,
    taxes: 4500,
    insurance: 1200,
    hoa: 0,
    targetDscr: 1.25 // For Reverse Mode
  });

  const [metrics, setMetrics] = useState({ 
    dscr: 0, 
    cashFlow: 0, 
    pitia: 0, 
    loanAmount: 0,
    maxOffer: 0 // For Reverse Mode
  });

  // --- INSTALL LISTENER ---
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallClick = () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') setInstallPrompt(null);
    });
  };

  const handleSendFeedback = () => {
    const subject = encodeURIComponent("EquiCheck Feedback");
    const body = encodeURIComponent(feedbackText);
    window.location.href = `mailto:kyle@adynton.com?subject=${subject}&body=${body}`;
    setShowFeedback(false);
    setFeedbackText('');
  };

  // --- CORE MATH ---
  useEffect(() => {
    const monthlyRate = values.interestRate / 100 / 12;
    const n = 30 * 12;
    const monthlyTaxes = values.taxes / 12;
    const monthlyInsurance = values.insurance / 12;
    const fixedCosts = monthlyTaxes + monthlyInsurance + values.hoa;

    if (calcMode === 'standard') {
        // STANDARD: Price -> DSCR
        const loanAmount = values.price * (1 - values.downPaymentPercent / 100);
        const mortgage = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1);
        const pitia = mortgage + fixedCosts;
        const dscr = pitia > 0 ? values.rent / pitia : 0;
        const cashFlow = values.rent - pitia;

        setMetrics({ 
            dscr: parseFloat(dscr.toFixed(2)), 
            cashFlow: Math.round(cashFlow), 
            pitia: Math.round(pitia),
            loanAmount: Math.round(loanAmount),
            maxOffer: 0
        });
    } else {
        // REVERSE: Target DSCR -> Max Price
        // 1. Max Allowable PITIA = Rent / TargetDSCR
        const maxPitia = values.rent / values.targetDscr;
        
        // 2. Max Mortgage Payment = Max PITIA - Fixed Costs
        const maxMortgagePayment = maxPitia - fixedCosts;

        if (maxMortgagePayment > 0) {
            // 3. Solve for Loan Amount (PV of annuity)
            // PV = PMT * (1 - (1+r)^-n) / r
            const maxLoan = maxMortgagePayment * (1 - Math.pow(1 + monthlyRate, -n)) / monthlyRate;
            
            // 4. Solve for Purchase Price = Loan / LTV
            // LTV = (100 - Down%) / 100
            const ltv = (100 - values.downPaymentPercent) / 100;
            const maxPrice = maxLoan / ltv;

            setMetrics({
                dscr: values.targetDscr, // Display target
                cashFlow: Math.round(values.rent - maxPitia), // Flow at that target
                pitia: Math.round(maxPitia),
                loanAmount: Math.round(maxLoan),
                maxOffer: Math.round(maxPrice)
            });
        } else {
            setMetrics({ dscr: 0, cashFlow: 0, pitia: 0, loanAmount: 0, maxOffer: 0 });
        }
    }
  }, [values, calcMode]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    const newValue = (name === 'address' || name === 'notes') ? value : (parseFloat(value) || 0);
    setValues({ ...values, [name]: newValue });
  };

  // --- PHOTO & PDF HANDLERS (Unchanged logic) ---
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

  const generatePDF = async () => {
    if (!values.address) { alert("Add an address first!"); return; }
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    let yPos = 20;

    const logoImg = await loadImageForPDF('/pwa-192x192.png');
    if (logoImg) {
        doc.addImage(logoImg, 'PNG', 20, 10, 20, 20);
        yPos = 35;
    }
    const titleX = logoImg ? 45 : 20;
    const titleY = logoImg ? 22 : 20;
    
    doc.setFontSize(22); doc.setTextColor(40);
    doc.text("EquiCheck Field Report", titleX, titleY);
    doc.setFontSize(10); doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, titleX, titleY + 6);

    doc.setFontSize(16); doc.setTextColor(0);
    doc.text(values.address, 20, yPos); yPos += 15;

    doc.setFillColor(240, 240, 240);
    doc.rect(15, yPos - 5, pageWidth - 30, 35, 'F');
    
    // PDF Logic for REVERSE mode needs to show Max Offer
    if (calcMode === 'reverse') {
         doc.setFontSize(12);
         doc.text("TARGET DSCR", 25, yPos + 5);
         doc.text("MAX OFFER PRICE", 85, yPos + 5);
         doc.text("EST. CASH FLOW", 145, yPos + 5);

         doc.setFontSize(18);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(0, 150, 0); doc.text(`$${metrics.maxOffer.toLocaleString()}`, 85, yPos + 15);
         doc.setTextColor(200, 0, 0); doc.text(`$${metrics.cashFlow}`, 145, yPos + 15);
    } else {
         doc.setFontSize(12);
         doc.text("DSCR SCORE", 25, yPos + 5);
         doc.text("CASH FLOW", 85, yPos + 5);
         doc.text("ALL-IN P.I.T.I.A", 145, yPos + 5);

         doc.setFontSize(18);
         doc.setTextColor(0, 0, 255); doc.text(metrics.dscr.toString(), 25, yPos + 15);
         doc.setTextColor(0, 150, 0); doc.text(`$${metrics.cashFlow}`, 85, yPos + 15);
         doc.setTextColor(200, 0, 0); doc.text(`$${metrics.pitia}`, 145, yPos + 15);
    }
    yPos += 45;

    doc.setTextColor(0); doc.setFontSize(12);
    doc.text("Financial Inputs", 20, yPos); yPos += 10;
    doc.setFontSize(10);
    
    // In Reverse Mode, Price is an Output, not Input
    if (calcMode === 'standard') {
        doc.text(`Purchase Price: $${values.price.toLocaleString()}`, 20, yPos);
    } else {
        doc.text(`Target DSCR: ${values.targetDscr}`, 20, yPos);
    }
    
    doc.text(`Down Payment: ${values.downPaymentPercent}%`, 20, yPos + 6);
    doc.text(`Loan Amount: $${metrics.loanAmount.toLocaleString()}`, 20, yPos + 12);
    doc.text(`Interest Rate: ${values.interestRate}%`, 20, yPos + 18);
    
    doc.text(`Est. Rent: $${values.rent.toLocaleString()}`, 110, yPos);
    doc.text(`Annual Tax: $${values.taxes.toLocaleString()}`, 110, yPos + 6);
    doc.text(`Annual Insurance: $${values.insurance.toLocaleString()}`, 110, yPos + 12);
    doc.text(`HOA: $${values.hoa}`, 110, yPos + 18);
    yPos += 30;

    if (values.notes) {
        doc.setFontSize(12); doc.text("Field Notes", 20, yPos); yPos += 7;
        doc.setFontSize(10);
        const splitNotes = doc.splitTextToSize(values.notes, 170);
        doc.text(splitNotes, 20, yPos);
        yPos += (splitNotes.length * 5) + 10; 
    }

    if (images.length > 0) {
        if (yPos > 240) { doc.addPage(); yPos = 20; }
        doc.setFontSize(12); doc.text(`Field Photos (${images.length})`, 20, yPos); yPos += 10;
        const imgWidth = 80; const imgHeight = 60; const gap = 10;
        images.forEach((imgData, index) => {
            if (yPos + imgHeight > 280) { doc.addPage(); yPos = 20; }
            const isRightColumn = index % 2 === 1;
            const xPos = isRightColumn ? 20 + imgWidth + gap : 20;
            doc.addImage(imgData, 'JPEG', xPos, yPos, imgWidth, imgHeight);
            if (isRightColumn || index === images.length - 1) {
                if (isRightColumn) yPos += imgHeight + gap;
                else if (index === images.length - 1) yPos += imgHeight + gap; 
            }
        });
    }
    doc.save(`${values.address.replace(/\s+/g, '_')}_EquiCheck.pdf`);
  };

  const handleSave = async () => {
    if (!values.address) { alert("Address required!"); return; }
    try {
        // Save the correct "Price" depending on mode
        const finalPrice = calcMode === 'standard' ? values.price : metrics.maxOffer;
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
    setCalcMode('standard'); // Default to standard when loading
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
                <textarea className="w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm h-32 mb-4 focus:outline-none focus:border-blue-500"
                    placeholder="Bug reports or feature requests..." value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)}/>
                <div className="flex justify-end gap-3">
                    <button onClick={() => setShowFeedback(false)} className="text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                    <button onClick={handleSendFeedback} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-bold">Send Email</button>
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
            <button onClick={() => setShowFeedback(true)} className="p-2 text-gray-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg></button>
            <a href="https://cash.me/$adynton" target="_blank" rel="noreferrer" className="p-2 text-pink-500 hover:text-pink-400"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" /></svg></a>
            {installPrompt && (<button onClick={handleInstallClick} className="bg-green-600 text-white px-2 py-1 rounded text-xs uppercase font-bold">Install</button>)}
        </div>
      </div>

      <div className="flex-grow">
          {!showHistory ? (
            <>
                {/* ADDRESS & HISTORY BUTTON */}
                <div className="flex gap-2 mb-4">
                     <input type="text" name="address" placeholder="Property Address" value={values.address} onChange={handleChange} className="flex-grow bg-gray-800 border-b-2 border-gray-600 focus:border-blue-500 p-2 text-lg outline-none"/>
                     <button onClick={() => setShowHistory(true)} className="text-xs bg-gray-800 px-3 py-1 rounded border border-gray-600 whitespace-nowrap">Load Saved</button>
                </div>

                {/* MODE TOGGLE */}
                <div className="flex bg-gray-800 p-1 rounded-lg mb-4">
                    <button 
                        onClick={() => setCalcMode('standard')}
                        className={`flex-1 py-2 rounded text-sm font-bold ${calcMode === 'standard' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>
                        Standard
                    </button>
                    <button 
                        onClick={() => setCalcMode('reverse')}
                        className={`flex-1 py-2 rounded text-sm font-bold ${calcMode === 'reverse' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}>
                        Max Offer (MAO)
                    </button>
                </div>

                {/* SCORE GAUGE */}
                <div className={`mb-6 p-4 border-2 rounded-xl text-center transition-colors ${getScoreColor(metrics.dscr)}`}>
                    {calcMode === 'standard' ? (
                        <div className="flex justify-around items-center">
                            <div><div className="text-4xl font-bold">{metrics.dscr}</div><div className="text-xs uppercase">DSCR</div></div>
                            <div className="text-left text-sm text-gray-300"><div>Flow: ${metrics.cashFlow}</div><div>PITIA: ${metrics.pitia}</div></div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center">
                            <div className="text-xs uppercase tracking-widest mb-1">Max Allowable Offer</div>
                            <div className="text-3xl font-bold text-white mb-2">${metrics.maxOffer.toLocaleString()}</div>
                            <div className="text-xs text-gray-300">To hit {values.targetDscr} DSCR</div>
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

                {/* INPUTS (CONDITIONAL) */}
                <div className="space-y-4 text-sm mb-20">
                    <div className="grid grid-cols-2 gap-4">
                        {/* CONDITIONAL FIRST ROW */}
                        {calcMode === 'standard' ? (
                             <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        ) : (
                             <div><label className="text-blue-400 font-bold">Target DSCR</label><input type="number" name="targetDscr" value={values.targetDscr} onChange={handleChange} className="w-full bg-gray-800 border border-blue-500 p-2 rounded"/></div>
                        )}
                        <div><label className="text-gray-500">Rent</label><input type="number" name="rent" value={values.rent} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded"/></div>
                        
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
                <div className="space-y-2">{savedProperties?.map((prop) => (<div key={prop.id} onClick={() => loadProperty(prop)} className="bg-gray-800 p-4 rounded-lg flex justify-between cursor-pointer hover:bg-gray-700"><div><div className="font-bold">{prop.address}</div><div className="text-xs text-gray-400">{prop.images?.length || 0} Photos</div></div><div className={`font-bold ${getScoreColor(prop.dscr).split(' ')[0]}`}>{prop.dscr}</div></div>))}</div>
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