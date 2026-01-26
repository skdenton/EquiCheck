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

const useDebounce = (value, delay) => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
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
  const [showSupport, setShowSupport] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const fileInputRef = useRef(null);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // Autocomplete
  const [suggestions, setSuggestions] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [userLocation, setUserLocation] = useState({ lat: 39.5, lon: -98.35 });

  // --- MODES ---
  const [calcMode, setCalcMode] = useState('standard');
  const [isItemized, setIsItemized] = useState(false);
  const [isPartnership, setIsPartnership] = useState(false);

  // --- DEFAULTS ---
  const [defaults, setDefaults] = useState({
    taxes: 4500, insurance: 1200, hoa: 0,
    targetDscr: 1.25, vacancy: 5, expenseRatio: 35,
    mgmt: 5, maint: 5, utils: 0,
    primaryRate: 7.5, primaryLtv: 80,
    closingCosts: 3,
    rentCastKey: ''
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
    investorEquity: 50, investorCapital: 100,
    rehab: 0, closingCosts: 3
  });

  const [metrics, setMetrics] = useState({
    dscr: 0, cashFlow: 0, pitia: 0, totalLoanAmount: 0,
    maxOffer: 0, cashOut: 0,
    capRate: 0, noi: 0, coc: 0,
    blendedRate: 0, cltv: 0,
    investorFlow: 0, sponsorFlow: 0, investorCoc: 0, sponsorCoc: 0,
    totalEntryFee: 0
  });

  const debouncedAddress = useDebounce(values.address, 300);

  // --- INIT ---
  useEffect(() => {
    // Note: We keep 'equicheck_defaults' key for backwards compatibility with user's existing local storage
    const stored = localStorage.getItem('equicheck_defaults');
    if (stored) {
      const p = JSON.parse(stored);
      setDefaults(p);
      setValues(prev => ({ ...prev, ...p }));
      setLoans([{ id: 1, name: 'Senior Debt', ltv: p.primaryLtv || 80, rate: p.primaryRate || 7.5, isIO: false }]);
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        (err) => console.log("GPS denied"), { enableHighAccuracy: false, timeout: 5000 }
      );
    }
  }, []);

  useEffect(() => {
    if (values.grossAnnual === 0 && values.rent > 0) setValues(prev => ({ ...prev, grossAnnual: prev.rent * 12 }));
  }, []);

  // --- INSTALL LISTENER (PWA) ---
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
      setInstallPrompt(null);
    });
  };

  // --- AUTOCOMPLETE ---
  useEffect(() => {
    if (debouncedAddress.length > 2 && showDropdown) {
      const cleanQuery = debouncedAddress.replace(/(\s+#\w+)|(\s+(apt|unit|ste)\s+\w+)/gi, '');
      fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery)}&limit=5&lat=${userLocation.lat}&lon=${userLocation.lon}`)
        .then(res => res.json()).then(data => setSuggestions(data.features)).catch(console.error);
    } else setSuggestions([]);
  }, [debouncedAddress, showDropdown, userLocation]);

  const fetchPropertyData = async (selectedAddress) => {
    if (!defaults.rentCastKey) return;
    setIsLoadingData(true);
    try {
      const response = await fetch(`https://api.rentcast.io/v1/properties?address=${encodeURIComponent(selectedAddress)}`, { headers: { 'X-Api-Key': defaults.rentCastKey } });
      const data = await response.json();
      if (data && data.length > 0) {
        const prop = data[0];
        const newValues = { ...values, address: selectedAddress };
        if (prop.price) newValues.price = prop.price;
        else if (prop.lastSalePrice) newValues.price = prop.lastSalePrice;
        if (prop.rent) { newValues.rent = prop.rent; newValues.grossAnnual = prop.rent * 12; }
        if (prop.lastTaxAmount) newValues.taxes = prop.lastTaxAmount;
        const details = `\n[Auto-Fill Data]\nBeds: ${prop.bedrooms || '?'} | Baths: ${prop.bathrooms || '?'}\nSqFt: ${prop.squareFootage || '?'}\nBuilt: ${prop.yearBuilt || '?'}`;
        newValues.notes = (newValues.notes || '') + details;
        setValues(newValues);
      }
    } catch (error) { alert("Could not fetch property data."); } finally { setIsLoadingData(false); }
  };

  const handleAddressSelect = (feature) => {
    const p = feature.properties;
    const fullAddr = `${p.housenumber || ''} ${p.street || ''}, ${p.city || ''}, ${p.state || ''} ${p.postcode || ''}`.trim().replace(/^ ,/, '');
    setValues(prev => ({ ...prev, address: fullAddr }));
    setShowDropdown(false);
    fetchPropertyData(fullAddr);
  };

  // --- CORE MATH ---
  useEffect(() => {
    const v = (key) => (values[key] === '' || values[key] === undefined) ? 0 : parseFloat(values[key]);
    const price = v('price');
    const monthlyGross = calcMode === 'cre' ? (v('grossAnnual') / 12) : v('rent');
    const rehab = v('rehab');
    const closingCostsVal = price * (v('closingCosts') / 100);

    let monthlyExpenses = 0;
    let fixedCosts = (v('taxes') / 12) + (v('insurance') / 12) + v('hoa');

    if (calcMode === 'cre') {
      const vacancyLoss = monthlyGross * (v('vacancy') / 100);
      if (isItemized) monthlyExpenses = (v('taxes') / 12) + (v('insurance') / 12) + (monthlyGross * (v('mgmt') / 100)) + (monthlyGross * (v('maint') / 100)) + v('utils') + vacancyLoss;
      else monthlyExpenses = monthlyGross * (v('expenseRatio') / 100);
    } else monthlyExpenses = fixedCosts;

    let dscr = 0, cashFlow = 0, pitia = 0, totalLoanAmount = 0, maxOffer = 0, cashOut = 0, capRate = 0, noi = 0, coc = 0, totalDebtService = 0, blendedRate = 0;

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

      if (calcMode === 'refi') cashOut = totalLoanAmount - v('existingDebt') - closingCostsVal;

      noi = (monthlyGross - monthlyExpenses) * 12;
      capRate = price > 0 ? (noi / price) * 100 : 0;

      const downPayment = Math.max(0, price - totalLoanAmount);
      const totalEntryFee = downPayment + rehab + closingCostsVal;
      coc = totalEntryFee > 0 ? ((cashFlow * 12) / totalEntryFee) * 100 : 0;
    }

    const downPayment = Math.max(0, price - totalLoanAmount);
    const totalEntryFee = downPayment + rehab + closingCostsVal;
    const investorCashIn = totalEntryFee * (v('investorCapital') / 100);
    const investorFlow = cashFlow * (v('investorEquity') / 100);
    const investorCoc = investorCashIn > 0 ? ((investorFlow * 12) / investorCashIn) * 100 : (investorFlow > 0 ? 9999 : 0);
    const sponsorCashIn = totalEntryFee * ((100 - v('investorCapital')) / 100);
    const sponsorFlow = cashFlow * ((100 - v('investorEquity')) / 100);
    const sponsorCoc = sponsorCashIn > 0 ? ((sponsorFlow * 12) / sponsorCashIn) * 100 : (sponsorFlow > 0 ? 9999 : 0);

    setMetrics({
      dscr: parseFloat(dscr.toFixed(2)), cashFlow: Math.round(cashFlow), pitia: Math.round(pitia),
      totalLoanAmount: Math.round(totalLoanAmount), maxOffer: Math.round(maxOffer), cashOut: Math.round(cashOut),
      capRate: parseFloat(capRate.toFixed(2)), noi: Math.round(noi), coc: parseFloat(coc.toFixed(2)),
      blendedRate: parseFloat(blendedRate.toFixed(3)), cltv: loans.reduce((sum, l) => sum + l.ltv, 0),
      investorFlow: Math.round(investorFlow), sponsorFlow: Math.round(sponsorFlow),
      investorCoc: parseFloat(investorCoc.toFixed(1)), sponsorCoc: parseFloat(sponsorCoc.toFixed(1)),
      totalEntryFee: Math.round(totalEntryFee)
    });

  }, [values, calcMode, isItemized, loans]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    const finalVal = (name === 'address' || name === 'notes' || name === 'rentCastKey') ? value : (value === '' ? '' : parseFloat(value));
    setValues({ ...values, [name]: finalVal });
  };
  const handleDefaultChange = (e) => setDefaults({ ...defaults, [e.target.name]: e.target.value === '' ? '' : parseFloat(e.target.value) });
  const updateLoan = (id, field, value) => setLoans(loans.map(l => l.id === id ? { ...l, [field]: value } : l));
  const addLoan = () => setLoans([...loans, { id: loans.length > 0 ? Math.max(...loans.map(l => l.id)) + 1 : 1, name: 'Sub Debt', ltv: 10, rate: 10, isIO: true }]);
  const removeLoan = (id) => { if (loans.length > 1) setLoans(loans.filter(l => l.id !== id)); };

  const handlePhotoCapture = async (e) => {
    if (e.target.files && e.target.files[0]) {
      setIsCompressing(true);
      const compressedBase64 = await compressImage(e.target.files[0]);
      setImages([...images, compressedBase64]); setIsCompressing(false);
    }
  };
  const removeImage = (idx) => setImages(images.filter((_, i) => i !== idx));

  // --- ACTIONS ---
  const handleSendFeedback = () => {
    const subject = encodeURIComponent("EZ Feasibility Feedback");
    const body = encodeURIComponent(feedbackText);
    window.location.href = `mailto:kyle@adynton.com?subject=${subject}&body=${body}`;
    setShowFeedback(false);
    setFeedbackText('');
  };

  const saveSettings = () => {
    localStorage.setItem('equicheck_defaults', JSON.stringify(defaults));
    setShowSettings(false);
  };

  const handleSave = async () => {
    if (!values.address) { alert("Address required!"); return; }
    try {
      const finalPrice = calcMode === 'reverse' ? metrics.maxOffer : values.price;
      await db.properties.add({ address: values.address, price: finalPrice, rent: values.rent, dscr: metrics.dscr, images: images, notes: values.notes, fullData: values, loans: loans, created: new Date() });
      alert("Saved!");
    } catch (e) { console.error(e); }
  };
  const handleBackup = async () => {
    try { const d = await db.properties.toArray(); const b = new Blob([JSON.stringify(d)], { type: "application/json" }); const l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = `EZ_Feasibility_Backup_${new Date().toISOString().slice(0, 10)}.json`; l.click(); } catch (e) { alert("Backup failed: " + e.message); }
  };
  const handleRestore = async (e) => {
    const f = e.target.files[0]; if (!f || !window.confirm("Overwrite current data?")) return; const r = new FileReader(); r.onload = async (ev) => { try { await db.properties.clear(); await db.properties.bulkAdd(JSON.parse(ev.target.result)); alert("Restored!"); } catch { alert("Invalid file."); } }; r.readAsText(f);
  };
  const loadProperty = (prop) => {
    setValues({ ...prop.fullData, notes: prop.fullData.notes || '' });
    if (prop.loans && prop.loans.length > 0) setLoans(prop.loans);
    else { const oldLtv = 100 - (prop.fullData.downPaymentPercent || 20); const oldRate = prop.fullData.interestRate || 7.5; setLoans([{ id: 1, name: 'Senior Debt', ltv: oldLtv, rate: oldRate, isIO: false }]); }
    setImages(prop.images || []); setCalcMode('standard'); setShowHistory(false);
  };
  const generatePDF = async () => {
    if (!values.address) { alert("Add an address first!"); return; }
    const doc = new jsPDF();
    let yPos = 20;
    const logoImg = await loadImageForPDF('/pwa-192x192.png');
    if (logoImg) { doc.addImage(logoImg, 'PNG', 20, 10, 20, 20); yPos = 35; }
    doc.setFontSize(22); doc.setTextColor(40);
    const title = calcMode === 'cre' ? "CRE Investment Analysis" : (calcMode === 'refi' ? "Refinance Analysis" : "EZ Feasibility Report");
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
    doc.text("Total Entry Fee (Cash to Close)", 20, yPos); yPos += 8;
    doc.setFontSize(10);
    doc.text(`Down Payment: $${(values.price - metrics.totalLoanAmount).toLocaleString()}`, 20, yPos);
    doc.text(`Rehab Budget: $${values.rehab.toLocaleString()}`, 100, yPos);
    doc.text(`Closing Costs: $${Math.round(values.price * (values.closingCosts / 100)).toLocaleString()} (${values.closingCosts}%)`, 20, yPos + 6);
    doc.setFontSize(12); doc.setTextColor(200, 0, 0);
    doc.text(`Total Cash Needed: $${metrics.totalEntryFee.toLocaleString()}`, 100, yPos + 6);
    yPos += 20;
    doc.setTextColor(0);
    doc.text("Capital Stack", 20, yPos); yPos += 10;
    doc.setFontSize(10);
    loans.forEach(l => { doc.text(`${l.name}: ${l.ltv}% LTV @ ${l.rate}% ${l.isIO ? '(IO)' : ''}`, 20, yPos); yPos += 6; });
    doc.text(`Blended Rate: ${metrics.blendedRate}% | CLTV: ${metrics.cltv}%`, 20, yPos + 2);
    yPos += 10;
    if (isPartnership) {
      doc.setFontSize(12); doc.text("Partnership Structure", 20, yPos); yPos += 10;
      doc.setFontSize(10);
      doc.text(`Investor: ${values.investorEquity}% Equity / ${values.investorCapital}% Capital`, 20, yPos);
      doc.text(`Sponsor: ${100 - values.investorEquity}% Equity / ${100 - values.investorCapital}% Capital`, 20, yPos + 6);
      doc.setTextColor(0, 150, 0);
      doc.text(`Investor Return: ${metrics.investorCoc >= 9999 ? '∞' : metrics.investorCoc + '%'} CoC ($${metrics.investorFlow}/mo)`, 20, yPos + 14);
      doc.setTextColor(0);
      yPos += 25;
    }
    doc.save(`${values.address.replace(/\s+/g, '_')}_EZ_Feasibility.pdf`);
  };
  const getScoreColor = (dscr) => { if (dscr >= 1.25) return 'text-green-400 border-green-400'; if (dscr >= 1.0) return 'text-yellow-400 border-yellow-400'; return 'text-red-500 border-red-500'; };

  return (
    <div className="p-4 max-w-md mx-auto bg-gray-900 min-h-screen text-gray-100 font-mono flex flex-col relative">

      {/* MODALS */}
      {showFeedback && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-4">
          <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600"><h3 className="text-xl font-bold mb-4">Send Feedback</h3><textarea className="w-full bg-gray-900 border border-gray-700 rounded p-3 text-sm h-32 mb-4 text-white" value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} /><div className="flex justify-end gap-3"><button onClick={() => setShowFeedback(false)} className="text-gray-400">Cancel</button><button onClick={handleSendFeedback} className="bg-blue-600 px-4 py-2 rounded">Send</button></div></div>
        </div>
      )}
      {showSettings && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[100] p-4">
          <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600 max-h-[80vh] overflow-y-auto"><h3 className="text-xl font-bold mb-4">Global Defaults</h3>
            <div className="space-y-3 text-sm">
              <div className="bg-gray-900 p-2 rounded border border-blue-900/50"><label className="text-blue-400 font-bold mb-1 block">RentCast API Key</label><input type="text" name="rentCastKey" value={defaults.rentCastKey} onChange={handleDefaultChange} placeholder="Paste key here..." className="w-full bg-gray-800 p-2 rounded border border-gray-700 text-xs" /><a href="https://rentcast.io/api" target="_blank" rel="noreferrer" className="text-[10px] text-gray-400 underline mt-1 block">Get a free key here</a></div>
              <div><label className="text-gray-400">Closing Costs %</label><input type="number" name="closingCosts" value={defaults.closingCosts} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700" /></div>
              <div><label className="text-gray-400">Primary Rate (%)</label><input type="number" name="primaryRate" value={defaults.primaryRate} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700" /></div>
              <div><label className="text-gray-400">Primary LTV %</label><input type="number" name="primaryLtv" value={defaults.primaryLtv} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700" /></div>
              <div className="pt-2 border-t border-gray-700 font-bold text-gray-500">CRE Defaults</div>
              <div><label className="text-gray-400">Expense Ratio (%)</label><input type="number" name="expenseRatio" value={defaults.expenseRatio} onChange={handleDefaultChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700" /></div>
            </div><div className="flex justify-end gap-3 mt-6"><button onClick={() => setShowSettings(false)} className="text-gray-400">Cancel</button><button onClick={saveSettings} className="bg-blue-600 px-4 py-2 rounded font-bold">Save Defaults</button></div></div>
        </div>
      )}

      {showSupport && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[100] p-4 text-center">
          <div className="bg-gray-800 p-6 rounded-lg w-full max-w-sm border border-gray-600">
            <h3 className="text-xl font-bold mb-6 text-white">Buy our devs coffee on CashApp</h3>
            <div className="flex justify-around items-end gap-2 mb-8">
              <a href="https://cash.app/$adynton/5" target="_blank" rel="noreferrer" className="flex flex-col items-center gap-2 group">
                <div className="text-gray-400 group-hover:text-blue-400 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10">
                    {/* Mug Body */}
                    <path d="M5 7c0 7 1 11 7 11s7-4 7-11" />
                    {/* Top Rim */}
                    <ellipse cx="12" cy="7" rx="7" ry="2" />
                    {/* Handle */}
                    <path d="M19 10c2.5 0 4 1 4 3s-1.5 3-4 3" strokeLinecap="round" />
                    {/* Highlight */}
                    <path d="M8 10v4" strokeWidth="1" strokeOpacity="0.4" strokeLinecap="round" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-gray-300">$5</span>
              </a>
              <a href="https://cash.app/$adynton/10" target="_blank" rel="noreferrer" className="flex flex-col items-center gap-2 group">
                <div className="text-gray-400 group-hover:text-blue-400 transition-colors relative">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0.2" className="w-12 h-12">
                    {/* Cup Body (Taller Taper) */}
                    <path d="M7 8.5h10l-1.2 13.5H8.2L7 8.5z" fillOpacity="0.2" />
                    {/* Straw */}
                    <path d="M13 2l1 6h1l-1-6h-1z" strokeLinecap="round" />
                    {/* Multi-tiered Lid (Shifted slightly) */}
                    <path d="M6 7h12v1.5H6V7z M7 6h10v1H7V6z M9 5h6v1H9V5z" />
                    {/* Circular Sleeve/Logo (Centered on taller body) */}
                    <circle cx="12" cy="14.5" r="2.5" fill="none" strokeWidth="0.8" />
                    <circle cx="12" cy="14.5" r="1.5" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-gray-300">$10</span>
              </a>
              <a href="https://cash.app/$adynton/20" target="_blank" rel="noreferrer" className="flex flex-col items-center gap-2 group">
                <div className="text-gray-400 group-hover:text-blue-400 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0.2" className="w-12 h-12">
                    {/* The Carafe Shape (Transparent) */}
                    <path d="M12 21a7.5 7.5 0 0 1-7.5-7.5c0-1.1.25-2.1.7-3L7.5 7h9l2.3 3.5c.45.9.7 1.9.7 3a7.5 7.5 0 0 1-7.5 7.5z" fillOpacity="0.2" />
                    {/* The Liquid (Half Full) */}
                    <path d="M4.58 13.5a7.5 7.5 0 0 0 14.84 0H4.58z" />
                    {/* The Handle */}
                    <path d="M16.5 8c2.5 0 4.5 1.5 4.5 4.5s-2 4-4.5 4" fill="none" strokeWidth="1.5" strokeLinecap="round" />
                    {/* The Lid & Spout Peak */}
                    <path d="M7 5.5l1-1.5h8l1 1.5H7z M6 5.5h12v1.5H6v-1.5z M10 4.5L6.5 3l1 1.5h2.5z" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-gray-300">$20</span>
              </a>
            </div>
            <button onClick={() => setShowSupport(false)} className="text-gray-500 hover:text-white text-sm font-bold uppercase tracking-widest">Close</button>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-2">
        <div className="flex items-center gap-3"><img src="/pwa-192x192.png" alt="Logo" className="w-8 h-8 rounded" /><h1 className="text-xl font-bold">EZ Feasibility</h1></div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.332.183-.582.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.221-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button onClick={() => setShowFeedback(true)} className="p-2 text-gray-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg></button>
          <button onClick={() => setShowSupport(true)} className="p-2 text-pink-500 hover:text-pink-400">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
            </svg>
          </button>
          {installPrompt && (<button onClick={handleInstallClick} className="bg-green-600 text-white px-2 py-1 rounded text-xs uppercase font-bold">Install</button>)}
        </div>
      </div>

      <div className="flex-grow">
        {!showHistory ? (
          <>
            {/* AUTOCOMPLETE DROPDOWN */}
            <div className="flex gap-2 mb-4 relative">
              <div className="flex-grow relative">
                <input type="text" name="address" placeholder="Property Address" value={values.address} onChange={(e) => { setValues({ ...values, address: e.target.value }); setShowDropdown(true); }} autoComplete="off" className="w-full bg-gray-800 border-b-2 border-gray-600 focus:border-blue-500 p-2 text-lg outline-none" />
                {suggestions.length > 0 && showDropdown && (
                  <ul className="absolute z-50 left-0 right-0 bg-gray-800 border border-gray-600 rounded-b shadow-xl max-h-48 overflow-y-auto">
                    {suggestions.map((s, i) => { const p = s.properties; return (<li key={i} onClick={() => handleAddressSelect(s)} className="p-3 border-b border-gray-700 hover:bg-gray-700 cursor-pointer text-sm"><div className="font-bold text-white">{p.name || (p.housenumber + ' ' + p.street)}</div><div className="text-gray-400 text-xs">{p.city}, {p.state} {p.postcode}</div></li>); })}
                  </ul>
                )}
                {isLoadingData && <div className="absolute right-2 top-3 text-blue-500 text-xs animate-pulse">Loading...</div>}
              </div>
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
                <div className="flex justify-around items-center"><div><div className="text-4xl font-bold">{metrics.capRate}%</div><div className="text-xs uppercase">CAP RATE</div></div><div className="text-left text-sm text-gray-300"><div>NOI: ${metrics.noi.toLocaleString()}</div><div>CoC: {metrics.coc}%</div></div></div>
              ) : calcMode === 'reverse' ? (
                <div className="flex flex-col items-center"><div className="text-xs uppercase tracking-widest mb-1">Max Allowable Offer</div><div className="text-3xl font-bold text-white mb-2">${metrics.maxOffer.toLocaleString()}</div><div className="text-xs text-gray-300">To hit {values.targetDscr} DSCR</div></div>
              ) : calcMode === 'refi' ? (
                <div className="flex flex-col items-center"><div className="text-xs uppercase tracking-widest mb-1">Est. Cash Out</div><div className={`text-4xl font-bold mb-2 ${metrics.cashOut >= 0 ? 'text-green-400' : 'text-red-500'}`}>${metrics.cashOut.toLocaleString()}</div><div className="text-xs text-gray-300">New DSCR: {metrics.dscr}</div></div>
              ) : (
                <div className="flex justify-around items-center"><div><div className="text-4xl font-bold">{metrics.dscr}</div><div className="text-xs uppercase">DSCR</div></div><div className="text-left text-sm text-gray-300"><div>Flow: ${metrics.cashFlow}</div><div>PITIA: ${metrics.pitia}</div></div></div>
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
                {calcMode === 'standard' && <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>}
                {calcMode === 'reverse' && <div><label className="text-blue-400 font-bold">Target DSCR</label><input type="number" name="targetDscr" value={values.targetDscr} onChange={handleChange} className="w-full bg-gray-800 border border-blue-500 p-2 rounded" /></div>}
                {calcMode === 'refi' && <div><label className="text-purple-400 font-bold">Appraised Value</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 border border-purple-500 p-2 rounded" /></div>}
                {calcMode === 'cre' && <div><label className="text-gray-500">Price</label><input type="number" name="price" value={values.price} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>}

                {calcMode === 'cre' ? (
                  <div><label className="text-green-400 font-bold">Gross Annual Inc</label><input type="number" name="grossAnnual" value={values.grossAnnual} onChange={handleChange} className="w-full bg-gray-800 border border-green-500 p-2 rounded" /></div>
                ) : (
                  <div><label className="text-gray-500">Rent (Monthly)</label><input type="number" name="rent" value={values.rent} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>
                )}
              </div>
              {calcMode === 'refi' && <div><label className="text-gray-500">Existing Debt</label><input type="number" name="existingDebt" value={values.existingDebt} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>}

              {/* PROJECT COSTS */}
              {calcMode !== 'reverse' && (
                <div className="bg-gray-800 p-3 rounded-lg border border-yellow-900/50">
                  <div className="flex justify-between items-center mb-2"><h3 className="text-xs font-bold uppercase text-yellow-500">Project Costs</h3><div className="text-[10px] text-gray-400">Total Entry Fee: <span className="text-white font-bold">${metrics.totalEntryFee.toLocaleString()}</span></div></div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-gray-500 text-xs">Rehab Budget ($)</label><input type="number" name="rehab" value={values.rehab} onChange={handleChange} className="w-full bg-gray-900 p-2 rounded border border-gray-700" /></div>
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1"><span>Closing Costs</span><span className="text-yellow-500">{values.closingCosts}%</span></div>
                      <input type="range" name="closingCosts" min="0" max="10" step="0.5" value={values.closingCosts} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                    </div>
                  </div>
                </div>
              )}

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
                      <div><label className="text-gray-500 text-xs">Mgmt %</label><input type="number" name="mgmt" value={values.mgmt} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded" /></div>
                      <div><label className="text-gray-500 text-xs">Maint %</label><input type="number" name="maint" value={values.maint} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded" /></div>
                      <div><label className="text-gray-500 text-xs">Util ($/mo)</label><input type="number" name="utils" value={values.utils} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded" /></div>
                      <div><label className="text-gray-500 text-xs">Tax/Yr</label><input type="number" name="taxes" value={values.taxes} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded" /></div>
                      <div><label className="text-gray-500 text-xs">Ins/Yr</label><input type="number" name="insurance" value={values.insurance} onChange={handleChange} className="w-full bg-gray-900 p-1 rounded" /></div>
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
                        <div><label className="text-gray-500 block">LTV %</label><input type="number" value={loan.ltv} onChange={(e) => updateLoan(loan.id, 'ltv', parseFloat(e.target.value))} className="w-full bg-gray-800 p-1 rounded" /></div>
                        <div><label className="text-gray-500 block">Rate %</label><input type="number" value={loan.rate} onChange={(e) => updateLoan(loan.id, 'rate', parseFloat(e.target.value))} className="w-full bg-gray-800 p-1 rounded" /></div>
                        <div className="flex items-center justify-center pt-4"><label className="flex items-center cursor-pointer gap-2"><input type="checkbox" checked={loan.isIO} onChange={(e) => updateLoan(loan.id, 'isIO', e.target.checked)} className="rounded bg-gray-700" /><span className="text-[10px] text-gray-400">IO Only</span></label></div>
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
                  <div><label className="text-gray-500 text-xs">Tax/Yr</label><input type="number" name="taxes" value={values.taxes} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>
                  <div><label className="text-gray-500 text-xs">Ins/Yr</label><input type="number" name="insurance" value={values.insurance} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>
                  <div><label className="text-gray-500 text-xs">HOA/Mo</label><input type="number" name="hoa" value={values.hoa} onChange={handleChange} className="w-full bg-gray-800 p-2 rounded" /></div>
                </div>
              )}

              {/* PARTNERSHIP SECTION */}
              <div className="bg-gray-800 p-3 rounded-lg border border-purple-900/50">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-bold uppercase text-purple-400">Partnership Split</h3>
                  <label className="flex items-center cursor-pointer relative"><input type="checkbox" checked={isPartnership} onChange={() => setIsPartnership(!isPartnership)} className="sr-only peer" /><div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div></label>
                </div>

                {isPartnership && (
                  <div className="space-y-4">
                    <div><div className="flex justify-between text-xs text-gray-400 mb-1"><span>Investor Ownership</span><span className="text-purple-400 font-bold">{values.investorEquity}%</span></div><input type="range" name="investorEquity" min="0" max="100" step="5" value={values.investorEquity} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" /><div className="text-[10px] text-gray-500 text-right">You own {100 - values.investorEquity}%</div></div>
                    <div><div className="flex justify-between text-xs text-gray-400 mb-1"><span>Investor Capital</span><span className="text-green-400 font-bold">{values.investorCapital}%</span></div><input type="range" name="investorCapital" min="0" max="100" step="5" value={values.investorCapital} onChange={handleChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" /><div className="text-[10px] text-gray-500 text-right">You put {100 - values.investorCapital}%</div></div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="bg-gray-900 p-2 rounded text-center"><div className="text-[10px] text-gray-400 uppercase">Investor CoC</div><div className="text-xl font-bold text-green-400">{metrics.investorCoc >= 9999 ? '∞' : metrics.investorCoc + '%'}</div><div className="text-[10px] text-gray-500">${metrics.investorFlow}/mo</div></div>
                      <div className="bg-gray-900 p-2 rounded text-center"><div className="text-[10px] text-gray-400 uppercase">Sponsor CoC</div><div className="text-xl font-bold text-blue-400">{metrics.sponsorCoc >= 9999 ? '∞' : metrics.sponsorCoc + '%'}</div><div className="text-[10px] text-gray-500">${metrics.sponsorFlow}/mo</div></div>
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