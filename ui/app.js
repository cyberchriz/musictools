(() => { // scoped call (IIFE) to prevent global namespace pollution

    // Native Alert Catcher
    window.onerror = function(msg, url, line) {
        const errString = msg ? msg.toString().toLowerCase() : "";
        if (errString.includes('resizeobserver')) return true; // Ignore benign layout warnings

        alert("FATAL BOOT ERROR:\n" + msg + "\nLine: " + line);
    };

    // --- NATIVE WRAPPER CRASH CATCHER ---
    window.addEventListener('error', (e) => {
        const errString = e.message ? e.message.toLowerCase() : "";
        if (errString.includes('resizeobserver')) return; // Ignore benign layout warnings

        const errDiv = document.createElement('div');
        errDiv.style.cssText = "position:fixed; top:0; left:0; width:100vw; background:#d32f2f; color:white; z-index:9999; padding:15px; font-family:monospace; font-size:12px; box-sizing:border-box;";
        errDiv.innerHTML = `<strong>APP ERROR</strong><br>${e.message}<br>Line: ${e.lineno} <button onclick="this.parentElement.remove()" style="float:right; color:black;">Close</button>`;
        document.body.appendChild(errDiv);
    });

    window.addEventListener('unhandledrejection', (e) => {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = "position:fixed; top:0; left:0; width:100vw; background:#f57c00; color:white; z-index:9999; padding:15px; font-family:monospace; font-size:12px; box-sizing:border-box;";
        errDiv.innerHTML = `<strong>PROMISE ERROR</strong><br>${e.reason} <button onclick="this.parentElement.remove()" style="float:right; color:black;">Close</button>`;
        document.body.appendChild(errDiv);
    });

    // =====================================================================
    // GLOBAL AUDIO WAKE TRAP (Defeats Browser Background Throttling)
    // =====================================================================
    const forceAudioWake = () => {
        if (typeof audioCtx !== 'undefined' && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
            audioCtx.resume().then(() => {
                console.log("AudioContext forcefully awakened by user gesture.");
                // Resync sequencer clocks so arps don't trigger all at once
                nextMetroTime = audioCtx.currentTime + 0.1;
                nextMidiPulseTime = audioCtx.currentTime + 0.1;
            }).catch(e => console.warn(e));
        }
    };

    // =====================================================================
    // WAKE UP SCREEN, AUDIO ENGINE & RESYNC CLOCKS AFTER THROTTLING
    // =====================================================================
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            
            // 1. Restore the Screen Wake Lock (Keeps the mobile screen on)
            if (typeof wakeLock !== 'undefined' && wakeLock !== null && typeof requestWakeLock === 'function') {
                requestWakeLock(); 
            }

            // 2. Resync the Audio Engine and Clocks
            if (typeof audioCtx !== 'undefined') {
                nextMetroTime = audioCtx.currentTime + 0.1;
                if (typeof nextMidiPulseTime !== 'undefined') nextMidiPulseTime = audioCtx.currentTime + 0.1;

                // Catch 'interrupted' or 'suspended' hardware states
                if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
                    try {
                        // Because this function is async, we can await the hardware wake!
                        await audioCtx.resume();
                        console.log("Audio Engine and Sequencer Clocks re-awakened!");
                    } catch (err) {
                        console.warn("Could not wake Audio Engine:", err);
                    }
                }
            }
        }
    });

    // Capture every possible interaction at the highest level
    window.addEventListener('mousedown', forceAudioWake, { capture: true });
    window.addEventListener('touchstart', forceAudioWake, { capture: true, passive: true });
    window.addEventListener('keydown', forceAudioWake, { capture: true })

    // =====================================================================
    // BROWSER SAFETY NET (Catches F5, Ctrl+W, Tab Close, Refresh)
    // =====================================================================
    window.addEventListener('beforeunload', (e) => {
        // Triggers the native "Leave Site? Changes may not be saved." warning
        e.preventDefault();
        e.returnValue = '';
    });

    // =====================================================================
    // 1. HARDWARE PROFILER & PERFORMANCE TIERS
    // =====================================================================

    // A. Base Platform Detection
    const isTauri = !!window.__TAURI__;
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

    // B. Mobile Detection (User Agent + Hardware Fallback for "Desktop Site" spoofing)
    let isMobileDevice = /Mobi|Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (!isMobileDevice && navigator.maxTouchPoints > 0 && (window.innerWidth <= 1366 || window.screen.width <= 1366)) {
        isMobileDevice = true;
    }

    // --- NATIVE WEBVIEW OPTIMIZATIONS ---
    window.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('dragstart', e => e.preventDefault());

    // C. Hardware Profiler
    const perfProfile = {
        cores: navigator.hardwareConcurrency || 2,
        ram: navigator.deviceMemory || 2,
        isMobile: isMobileDevice,
        isTauri: isTauri,
        tier: 'high'
    };

    // Determine Performance Tier
    if (perfProfile.isMobile && (perfProfile.cores <= 4 || perfProfile.ram <= 3)) {
        perfProfile.tier = 'low'; // Old phones, cheap tablets
    } else if (perfProfile.isMobile || perfProfile.cores <= 4) {
        perfProfile.tier = 'mid'; // Modern phones, older laptops
    } else {
        perfProfile.tier = 'high'; // Modern desktops, M-series Macs
    }

    console.log(`Hardware Profile: ${perfProfile.cores} Cores, ${perfProfile.ram}GB RAM. Tier: ${perfProfile.tier}`);

    // Inject the tier directly into the CSS engine
    document.body.classList.add(`perf-${perfProfile.tier}`);

    // D. Dynamic Engine Constants
    let maxVoices = perfProfile.tier === 'low' ? 6 : (perfProfile.tier === 'mid' ? 12 : 24);
    let globalVoicePool = [];

    const targetFPS = perfProfile.tier === 'high' ? 60 : 30;
    const frameInterval = 1000 / targetFPS;
    let lastVisualFrameTime = 0;

    // Pre-allocate massive arrays globally to bypass the Garbage Collector
    const VISUALIZER_BUFFER_SIZE = 2048;
    const sharedVisualizerData = new Float32Array(VISUALIZER_BUFFER_SIZE);

    // --- NATIVE PLATFORM APIs (WakeLock & Haptics) ---
    let wakeLock = null;
    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try { wakeLock = await navigator.wakeLock.request('screen'); }
            catch (err) { console.error('WakeLock Error:', err); }
        }
    }

    function triggerHaptic() {
        // 10ms is a crisp, premium "click" feel (only fires on supported mobile devices)
        if (isMobileDevice && navigator.vibrate) navigator.vibrate(10);
    }

    // =====================================================================
    // WAKE UP AUDIO ENGINE & RESYNC CLOCKS AFTER BACKGROUND THROTTLING
    // =====================================================================
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && typeof audioCtx !== 'undefined') {

            // 1. Resync the JavaScript Sequencer Clocks!
            // This prevents the engine from trying to play 10,000 missed background beats instantly.
            nextMetroTime = audioCtx.currentTime + 0.1;
            nextMidiPulseTime = audioCtx.currentTime + 0.1;

            // 2. Wake up the Audio Hardware
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().then(() => {
                    console.log("Audio Engine and Sequencer Clocks re-awakened!");
                }).catch(err => {
                    console.warn("Could not wake Audio Engine:", err);
                });
            }
        }
    });

    // ==========================================
    // GLOBAL STATE, OVERLAYS & THEME LOGIC
    // ==========================================
    const tonnetzWrapper = document.getElementById('tonnetz-wrapper');
    const tonnetzZoomGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    tonnetzZoomGroup.id = 'tonnetz-zoom-group';

    let t_scale = 1.2, t_panX = 0, t_panY = 0, t_isDragging = false, t_startX, t_startY;
    let currentPianoMin = null, currentPianoMax = null;
    let targetPanX = 0, targetPanY = 0;
    let isAnimatingPan = false, panIntervalId = null;
    let masterTune = 440;

    let isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark-theme', isDarkMode);

    const DX = 140; const DY = DX * Math.sqrt(3) / 2;
    const gridBuffer = 2;
    const GRID_W = 1600;
    const GRID_H = 1200;

    let showExtensions = false, showChordDegrees = false;
    let currentIdentifiedRootPC = null;
    let currentGravityTargets = [];
    let rootHistory = []; // Tracks the last 3 chord roots
    let isStrongSequence = false;   // Toggles the inward Gravity Well
    let noteMemoryMap = new Map(); // harmonic buffer for heat mapping
    const degreeNames = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];

    // --- METRONOME & TIME SIGNATURE STATE ---
    let beatsPerBar = 4;
    let metronomeMode = 0; // 0: Off, 1: Count-In, 2: Continuous
    let isMetronomePlaying = false;
    let nextMetronomeTick = 0;
    let metronomeBeatCount = 0;
    let metronomeGain = null;
    const AUDIO_PREROLL = 0.05; // 50ms engine lookahead to prevent Web Audio scheduling pops

    let currentArpBPM = 120, currentArpRhythm = 'slow', currentArpSwing = 0, currentArpLoop = true;
    let sustainHeld = false, sustainLocked = false, dampenHeld = false;
    let voiceLeadHeld = false;
    let lastPlayedMidiNotes = []; // <--- Memory for the voice leading engine
    let glideHeld = false, glideLocked = false, currentGlideMode = 'always';
    let octDownHeld = false, octUpHeld = false, octLocked = false, octMode = 'up';
    let arpUpHeld = false, arpDownHeld = false, arpUpDownHeld = false, arpRandomHeld = false, arpLocked = false, arpMode = 'up';
    let add6Held = false, add7Held = false, add7Locked = false, add9Held = false, add11Held = false;
    let add13Held = false, addFlat9Held = false, addSharp9Held = false, addSharp11Held = false, addFlat13Held = false;
    let add69Held = false, addMaj7Held = false, addFlat5Held = false, addSharp5Held = false, addSus4Held = false, addSus2Held = false;

    let snapToScale = false, currentTuning = 'equal';

    let isGenActive = false, isEnvActive = false, isPianoActive = true, isCofActive = false, isInfoActive = false, isSettingsActive = false;
    let isSynthActive = false, isMacroActive = false, isPadsActive = false, isDrumsActive = false, isMixerActive = false;
    let isHumanizeActive = false;
    let isBounceActive = false;
    let isPianoRollActive = false; 
    let isMacroDragging = false;   // Locks Tonnetz hit-testing
    let currentPlaybackBar = -1;   // Tracks bars for Chord Memory Reset

    let activeOverlay = 'settings';
    let lastSafeOffsetX = 0, lastSafeOffsetY = 0;

    let prClipboard = []; // Global Midi Clipboard

    const CHORD_BUFFER_MAX = 5; // Max notes in the rolling queue for chord/harmony analysis (best root and lowest note always get prioritized for preservation within the bucket!)

    const MAX_BPM_STRETCH_RATIO = 0.15; // 15% threshold for time-stretching
    let audioClips = []; // Stores objects: { id, trackId, buffer, startBeat, durationBeats, sourceNode }
    let globalAudioClipCounter = 0;

    let stepKeysHeldCount = 0;

    let currentArrangerTrackCount = 8;

    let isExportActive = false; // UI State
    let isExporting = false; // Engine State
    let exportAbortController = null;
    let exportTimeoutId = null;

    let currentOsc2Pitch = 0;
    let currentSampleStart = 0;
    let currentModWheel = 0; // Float 0.0 to 1.0

    // =====================================================================
    // GENERAL MIDI (GM) DRUM MAP & ALIAS ROUTING
    // =====================================================================
    const gmDrumMap = {
        35: { name: 'Acoustic Bass Drum', alias: 'kick' },
        36: { name: 'Bass Drum 1', alias: 'kick' },
        37: { name: 'Side Stick', alias: 'rimshot' },
        38: { name: 'Acoustic Snare', alias: 'snare' },
        39: { name: 'Hand Clap', alias: 'clap' },
        40: { name: 'Electric Snare', alias: 'snare' },
        41: { name: 'Low Floor Tom', alias: 'tom3' },
        42: { name: 'Closed Hi Hat', alias: 'hihat' },
        43: { name: 'High Floor Tom', alias: 'tom3' },
        44: { name: 'Pedal Hi-Hat', alias: 'hihat' },
        45: { name: 'Low Tom', alias: 'tom2' },
        46: { name: 'Open Hi-Hat', alias: 'hihat' },
        47: { name: 'Low-Mid Tom', alias: 'tom2' },
        48: { name: 'Hi-Mid Tom', alias: 'tom1' },
        49: { name: 'Crash Cymbal 1', alias: 'cymbal' },
        50: { name: 'High Tom', alias: 'tom1' },
        51: { name: 'Ride Cymbal 1', alias: 'ride' },
        52: { name: 'Chinese Cymbal', alias: 'cymbal' },
        53: { name: 'Ride Bell', alias: 'ride' },
        54: { name: 'Tambourine', alias: 'rimshot' },
        55: { name: 'Splash Cymbal', alias: 'cymbal' },
        56: { name: 'Cowbell', alias: 'cowbell' },
        57: { name: 'Crash Cymbal 2', alias: 'cymbal' },
        58: { name: 'Vibraslap', alias: 'cymbal' },
        59: { name: 'Ride Cymbal 2', alias: 'ride' },
        60: { name: 'Hi Bongo', alias: 'tom1' },
        61: { name: 'Low Bongo', alias: 'tom2' },
        62: { name: 'Mute Hi Conga', alias: 'tom1' },
        63: { name: 'Open Hi Conga', alias: 'tom2' },
        64: { name: 'Low Conga', alias: 'tom3' },
        65: { name: 'High Timbale', alias: 'tom1' },
        66: { name: 'Low Timbale', alias: 'tom2' },
        67: { name: 'High Agogo', alias: 'rimshot' },
        68: { name: 'Low Agogo', alias: 'rimshot' },
        69: { name: 'Cabasa', alias: 'rimshot' },
        70: { name: 'Maracas', alias: 'hihat' },
        71: { name: 'Short Whistle', alias: 'hihat' },
        72: { name: 'Long Whistle', alias: 'cymbal' },
        73: { name: 'Short Guiro', alias: 'hihat' },
        74: { name: 'Long Guiro', alias: 'cymbal' },
        75: { name: 'Claves', alias: 'rimshot' },
        76: { name: 'Hi Wood Block', alias: 'click' },
        77: { name: 'Low Wood Block', alias: 'click' },
        78: { name: 'Mute Cuica', alias: 'tom1' },
        79: { name: 'Open Cuica', alias: 'tom2' },
        80: { name: 'Mute Triangle', alias: 'click' },
        81: { name: 'Open Triangle', alias: 'cymbal' }
    };

    function showToast(msg) {
        let toast = document.getElementById('toast-container');
        if (toast) { toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2500); }
    }

    // =====================================================================
    // FILENAME TO MIDI CONVERTER
    // =====================================================================
    function extractMidiFromFilename(filename) {
        if (!filename) return 60;

        // REGEX EXPLANATION:
        // (?:^|[^a-zA-Z]) -> Must start at the beginning of the string OR after a non-letter (prevents matching "flac4" or "mp3")
        // ([a-gA-G])      -> Matches exactly one letter A through G
        // ([#b]?)         -> Optionally matches a sharp (#) or flat (b)
        // (-?\d{1,3})     -> Matches 1 to 3 digits, optionally preceded by a minus sign (for negative octaves like C-1)
        // (?:[^a-zA-Z]|$) -> Must be followed by a non-letter or the end of the string
        const regex = /(?:^|[^a-zA-Z])([a-gA-G])([#b]?)(-?\d{1,3})(?:[^a-zA-Z]|$)/;
        const match = filename.match(regex);
        
        if (!match) return 60; // Default to Middle C if no pattern is found

        const noteName = match[1].toUpperCase();
        const accidental = match[2].toLowerCase();
        const octave = parseInt(match[3], 10);

        // Map note names to base pitch classes
        const notes = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
        let pitchClass = notes[noteName];

        // Apply accidentals
        if (accidental === '#') pitchClass += 1;
        if (accidental === 'b') pitchClass -= 1;

        // MIDI Math: C4 = Note 60. Formula: (Octave + 1) * 12 + PitchClass
        let midiNote = (octave + 1) * 12 + pitchClass;
        
        // Clamp to valid MIDI range
        return Math.max(0, Math.min(127, midiNote));
    }

    // --- UNIFIED MOD WHEEL CONTROLLER ---
    function setModWheel(val0to1) {
        // 1. Anchor the state (clamp between 0.0 and 1.0)
        currentModWheel = Math.max(0, Math.min(1.0, val0to1));

        // 2. Update the new Synth Overlay Slider (0 to 1 scale)
        const synthModSlider = document.getElementById('modWheel');
        if (synthModSlider && synthModSlider.value != currentModWheel) {
            synthModSlider.value = currentModWheel;
        }

        // 3. Update the legacy MIDI UI Slider (0 to 127 scale)
        const midiVal127 = Math.round(currentModWheel * 127);
        const midiModSlider = document.getElementById('midiModWheel');
        if (midiModSlider && midiModSlider.value != midiVal127) {
            midiModSlider.value = midiVal127;
            if (typeof updateLabel === 'function') updateLabel('midiModWheel', midiVal127, 'Mod Wheel');
        }

        // 4. Send MIDI CC1 Out to connected external hardware
        if (typeof midiOut !== 'undefined' && midiOut) {
            for (let c = 0; c < 16; c++) midiOut.send([0xB0 + c, 1, midiVal127]);
        }

        // 5. Apply the live audio modulation to internal Web Audio engine
        applyModWheelToActiveVoices(currentModWheel);
    }

    // --- THE LIVE AUDIO MODULATOR ---
    function applyModWheelToActiveVoices(val) {
        if (typeof globalVoicePool === 'undefined' || !audioCtx) return;
        const now = audioCtx.currentTime;
    
        globalVoicePool.forEach(v => {
            // Mod Wheel pushes the filter cutoff higher AND increases vibrato depth simultaneously
            if (v.filter && v.baseCutoff) {
                const macroCutoff = Math.min(20000, v.baseCutoff * (1 + (val * 3))); // Up to 3x brighter
                v.filter.frequency.setTargetAtTime(macroCutoff, now, 0.05);
            }
            if (v.vPitchGain) {
                // Adds up to 50 cents of extra vibrato depth
                v.vPitchGain.gain.setTargetAtTime((typeof currentVibrato !== 'undefined' ? currentVibrato : 0) + (val * 50), now, 0.05);
            }
        });
    }

    function isSustainOn() { return sustainLocked || sustainHeld; }
    function isGlidePadOn() { return glideLocked || glideHeld; }
    function is6thOn() { return add6Held; }
    function is7thOn() { return add7Locked || add7Held; }
    function is9thOn() { return add9Held; }
    function is11thOn() { return add11Held; }
    function is13thOn() { return add13Held; }
    function isFlat9On() { return addFlat9Held; }
    function isSharp9On() { return addSharp9Held; }
    function isSharp11On() { return addSharp11Held; }
    function isFlat13On() { return addFlat13Held; }
    function is69On() { return add69Held; }
    function isMaj7On() { return addMaj7Held; }
    function isFlat5On() { return addFlat5Held; }
    function isSharp5On() { return addSharp5Held; }
    function isSus4On() { return addSus4Held; }
    function isSus2On() { return addSus2Held; }

    function isArpOn() { return arpLocked || arpUpHeld || arpDownHeld || arpUpDownHeld || arpRandomHeld; }
    function isOctUpOn() { return octUpHeld || (octLocked && octMode === 'up'); }
    function isOctDownOn() { return octDownHeld || (octLocked && octMode === 'down'); }

    let currentKeyCenter = 0, currentScale = 'all', currentLabelType = 'absolute';

    let currentDeclick = 0.010; // Default to 10 milliseconds
    let globalStaggerCounter = 0; // Tracks global voice spawning to prevent phase summing

    // for metronome feature: play a single click (High pitch for Downbeat, Low pitch for Offbeats)
    function playClick(time, isAccent) {
        if (!audioCtx || !metronomeGain) return;
        const osc = audioCtx.createOscillator();
        const env = audioCtx.createGain();
        osc.connect(env);
        env.connect(metronomeGain);
    
        osc.frequency.value = isAccent ? 1200 : 800;
    
        // Sharp, percussive envelope
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(0.6, time + 0.005);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    
        osc.start(time);
        osc.stop(time + 0.05);
    }

    // Scheduled by the main engine loop
    function scheduleClickTrack() {
        if (!audioCtx || !isMetronomePlaying || metronomeMode === 0) return;
        const lookahead = 0.1; // 100ms
        while (nextMetronomeTick < audioCtx.currentTime + lookahead) {
            playClick(nextMetronomeTick, metronomeBeatCount % beatsPerBar === 0);
            nextMetronomeTick += (60 / currentArpBPM);
            metronomeBeatCount++;
        }
    }

    function getExtendedStArray(stArray) {
        let res = [...stArray];
        if (res.length >= 3) {
            const root = res[0]; const third = res[1]; const fifth = res[2];

            // Alterations (Replacing base notes)
            if (isFlat5On()) { res = res.filter(st => st !== fifth); res.push(root + 6); }
            if (isSharp5On()) { res = res.filter(st => st !== fifth); res.push(root + 8); }
            if (isSus4On()) { res = res.filter(st => st !== third); res.push(root + 5); }
            if (isSus2On()) { res = res.filter(st => st !== third); res.push(root + 2); }

            // Extensions (Adding notes)
            if (is69On()) { res.push(root + 9); res.push(root + 14); }
            if (isMaj7On()) { res.push(root + 11); }
            if (is6thOn()) res.push(root + 9);
            if (is7thOn()) res.push(root + 10); // ALWAYS Dominant 7th (+10)
            if (is9thOn()) res.push(root + 14);
            if (is11thOn()) res.push(root + 17);
            if (is13thOn()) res.push(root + 21);
            if (isFlat9On()) res.push(root + 13);
            if (isSharp9On()) res.push(root + 15);
            if (isSharp11On()) res.push(root + 18);
            if (isFlat13On()) res.push(root + 20);
        }
        // Ensure unique notes, sorted from lowest to highest pitch for perfect Arpeggiation
        return Array.from(new Set(res)).sort((a, b) => a - b);
    }

    function applyArpMode(freqs) {
        let res = [...freqs];
        if (arpMode === 'down') { res.reverse(); }
        else if (arpMode === 'updown') { const reversed = [...res].reverse(); reversed.shift(); reversed.pop(); res = res.concat(reversed); }
        else if (arpMode === 'random') { for (let i = res.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[res[i], res[j]] = [res[j], res[i]]; } }
        return res;
    }

    function retriggerHeldNodes() {
        if (!audioCtx) return;

        const processNode = (nodeData) => {
            if (!nodeData || !nodeData.originalStArray) return;

            let extendedSt = getExtendedStArray(nodeData.originalStArray);
            let snapped = snapStArray(extendedSt);
            let targetFreqs = snapped.map(st => getFreqFromSt(st));
            if (isOctUpOn()) targetFreqs = targetFreqs.map(f => f * 2);
            if (isOctDownOn()) targetFreqs = targetFreqs.map(f => f * 0.5);

            // --- VOICE LEADING INTERCEPT FOR HELD CHORDS ---
            if (typeof voiceLeadHeld !== 'undefined' && voiceLeadHeld) {
                targetFreqs = applyVoiceLeading(targetFreqs);
            }

            // Update the memory bank so the engine tracks this modified chord's new center of gravity!
            if (typeof lastPlayedMidiNotes !== 'undefined') {
                lastPlayedMidiNotes = targetFreqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
            }

            // --- REAL-TIME EXTENSION INJECTION ---
            if (nodeData.isStepPreview && typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
                handleStepEntry(targetFreqs, snapped, null, 1);
                if (typeof drawPianoRoll === 'function') drawPianoRoll();
            }

            const shouldBeArp = isArpOn() && targetFreqs.length > 1;
            const wasArp = nodeData.type === 'arp';

            if (shouldBeArp && wasArp) {
                nodeData.freqs = applyArpMode(targetFreqs);
                const beatDuration = 60 / currentArpBPM;
                nodeData.stepDuration = targetFreqs.length === 3 ?
                    (currentArpRhythm === 'fast' ? (beatDuration / 3) : ((beatDuration * 2) / 3)) :
                    (currentArpRhythm === 'fast' ? (beatDuration / 4) : (beatDuration / 2));
            }
            else if (!shouldBeArp && !wasArp) {
                // Seamless Transitions: Only spawn missing notes, gently fade out removed notes
                let currentFreqs = nodeData.voices.map(v => v.freq);
                let toAdd = targetFreqs.filter(f => !currentFreqs.some(cf => Math.abs(cf - f) < 0.1));
                let toRemoveVoices = nodeData.voices.filter(v => !targetFreqs.some(tf => Math.abs(tf - v.freq) < 0.1));

                toAdd.forEach(freq => {
                    const voice = spawnVoice(freq, audioCtx.currentTime, 0, targetFreqs.length, true, nodeData.synthState, nodeData.destination);
                    nodeData.voices.push(voice); nodeData.freqs.push(freq);
                });

                if (toRemoveVoices.length > 0) {
                    beginRelease(toRemoveVoices, false);
                    nodeData.voices = nodeData.voices.filter(v => !toRemoveVoices.includes(v));
                    nodeData.freqs = nodeData.freqs.filter(f => !toRemoveVoices.some(rv => Math.abs(rv.freq - f) < 0.1));
                }
            }
            else {
                // Force complete retrigger only when switching between Chord and Arp modes
                if (nodeData.voices.length > 0) beginRelease(nodeData.voices, false);
                nodeData.voices = [];

                if (shouldBeArp) {
                    nodeData.type = 'arp'; nodeData.freqs = applyArpMode(targetFreqs);
                    const beatDuration = 60 / currentArpBPM;
                    nodeData.stepDuration = targetFreqs.length === 3 ?
                        (currentArpRhythm === 'fast' ? (beatDuration / 3) : ((beatDuration * 2) / 3)) :
                        (currentArpRhythm === 'fast' ? (beatDuration / 4) : (beatDuration / 2));
                    nodeData.nextNoteTime = audioCtx.currentTime; nodeData.noteIndex = 0;
                } else {
                    nodeData.type = 'chord'; nodeData.freqs = targetFreqs;
                    nodeData.voices = targetFreqs.map((freq) => spawnVoice(freq, audioCtx.currentTime, 0, targetFreqs.length, true, nodeData.synthState, nodeData.destination));
                }
            }
        };

        // Process all live notes (Tonnetz, Piano, and Sustained chords)
        activeNodes.forEach(processNode);
        sustainedVoices.forEach(processNode);

        updateHighlights();
    }

    function updateOverlayCSSVars() {
        const isPortrait = window.innerHeight > window.innerWidth;

        let topH = 0, leftW = 0, rightW = 0;
        let L = 0, T = 0, R = 0, B = 0;

        const activeLeft = document.querySelector('.overlay.primary.active');
        const pianoEl = document.getElementById('piano-overlay');
        const prEl = document.getElementById('piano-roll-overlay');
        const isUiAsleep = document.body.classList.contains('ui-hidden');

        if (isPianoActive && pianoEl) B = pianoEl.offsetHeight;

        let visiblePrHeight = 0;
        if (isPianoRollActive && prEl) {
            const isPrAutoHiding = isUiAsleep && prEl.classList.contains('auto-hides');
            if (!isPrAutoHiding) {
                visiblePrHeight = prEl.offsetHeight || (window.innerHeight * (parseFloat(document.getElementById('prHeightSlider')?.value || 50) / 100));
            }
        }

        B += visiblePrHeight;
        document.documentElement.style.setProperty('--pr-actual-h', `${visiblePrHeight}px`);

        if (activeLeft) {
            if (isPortrait) T = activeLeft.offsetHeight;
            else L = activeLeft.offsetWidth;
        }

        if (activeLeft) {
            const autoHides = ['settings-overlay', 'synth-overlay', 'mixer-overlay', 'pads-overlay', 'drums-overlay'].includes(activeLeft.id);
            if (!(isUiAsleep && autoHides)) {
                if (isPortrait) topH = activeLeft.offsetHeight;
                else leftW = activeLeft.offsetWidth;
            }
        }

        document.documentElement.style.setProperty('--active-overlay-height', `${topH}px`);
        document.documentElement.style.setProperty('--right-panel-w', `0px`);
        document.documentElement.style.setProperty('--left-panel-w', `${leftW}px`);

        // =========================================================
        // --- NEW: DYNAMIC TOP STACKING MEASUREMENT ---
        // =========================================================
        let totalTopOffset = 0;
        const mt = document.getElementById('master-transport');
        const dpad = document.getElementById('canvas-controls');
        
        if (mt && mt.style.display !== 'none') {
            totalTopOffset += mt.offsetHeight;
        }
        
        // Measure D-Pad ONLY if it is currently in its stretched toolbar form
        if (dpad && dpad.classList.contains('pr-high-stretched')) {
            totalTopOffset += (dpad.offsetHeight - 1); // -1px prevents double-thick CSS borders
        }
        
        document.documentElement.style.setProperty('--top-offset', `${totalTopOffset}px`);
        // =========================================================

        let newSafeOffsetX = L / 2;
        let newSafeOffsetY = (T - B) / 2;

        if (newSafeOffsetX !== lastSafeOffsetX || newSafeOffsetY !== lastSafeOffsetY) {
            lastSafeOffsetX = newSafeOffsetX;
            lastSafeOffsetY = newSafeOffsetY;
            applyTransform(); 
        }

        const controlsContainer = document.getElementById('canvas-controls');
        if (controlsContainer) {
            controlsContainer.classList.toggle('fab-shifted', !!activeLeft);
        }

        // Trigger the collision engine immediately after the CSS vars update
        // (The 10ms timeout ensures the DOM has fully applied the 'active' classes and animations before measuring)
        setTimeout(evaluatePanelCollisions, 10);
    }

    function updatePianoRange() {
        const w = window.innerWidth; const h = window.innerHeight;
        const x_min = (-w / 2 - t_panX) / t_scale; const x_max = (w / 2 - t_panX) / t_scale;
        const y_min = (-h / 2 - t_panY) / t_scale; const y_max = (h / 2 - t_panY) / t_scale;

        let minMidi = Infinity; let maxMidi = -Infinity;
        const gridBuffer = 2; const jMin_grid = Math.floor((-1000 / 2) / DY) - gridBuffer; const jMax_grid = Math.ceil((1000 / 2) / DY) + gridBuffer;

        let j_min_vis = Math.max(Math.floor(y_min / DY), jMin_grid);
        let j_max_vis = Math.min(Math.ceil(y_max / DY), jMax_grid);

        for (let j = j_min_vis; j <= j_max_vis; j++) {
            let i_min_vis = Math.max(Math.floor((x_min - j * (DX / 2)) / DX), Math.floor((-1200 / 2 - j * (DX / 2)) / DX) - gridBuffer);
            let i_max_vis = Math.min(Math.ceil((x_max - j * (DX / 2)) / DX), Math.ceil((1200 / 2 - j * (DX / 2)) / DX) + gridBuffer);
            for (let i = i_min_vis; i <= i_max_vis; i++) {
                const st = i * 7 + j * 4 + 60;
                if (st < minMidi) minMidi = st; if (st > maxMidi) maxMidi = st;
            }
        }

        if (minMidi === Infinity) { minMidi = 48; maxMidi = 72; }
        minMidi = Math.max(0, Math.min(minMidi, 127)); maxMidi = Math.max(0, Math.min(maxMidi, 127));

        const whiteKeys = [0, 2, 4, 5, 7, 9, 11];
        while (!whiteKeys.includes(minMidi % 12) && minMidi > 0) minMidi--;
        while (!whiteKeys.includes(maxMidi % 12) && maxMidi < 127) maxMidi++;

        if (maxMidi - minMidi < 11) {
            maxMidi = Math.min(127, minMidi + 11);
            while (!whiteKeys.includes(maxMidi % 12) && maxMidi < 127) maxMidi++;
        }

        if (currentPianoMin !== minMidi || currentPianoMax !== maxMidi) {
            currentPianoMin = minMidi; currentPianoMax = maxMidi;
            let visibleWhiteKeys = 0;
            document.querySelectorAll('.piano-key').forEach(key => {
                let note = parseInt(key.dataset.note);
                if (note >= minMidi && note <= maxMidi) { key.style.display = ''; if (whiteKeys.includes(note % 12)) visibleWhiteKeys++; }
                else { key.style.display = 'none'; }
            });
            const pianoContainer = document.getElementById('piano-overlay');
            if (pianoContainer && visibleWhiteKeys > 0) pianoContainer.style.setProperty('--key-width', `calc(100vw / ${visibleWhiteKeys})`);
        }
    }

    function constrainView() {
        const wrapper = document.getElementById('tonnetz-wrapper');
        if (!wrapper) return;
        const w = wrapper.clientWidth;
        const h = wrapper.clientHeight;

        // 1. Constrain Zoom: Never allow the grid to be smaller than the screen
        const minScaleX = w / GRID_W;
        const minScaleY = h / GRID_H;
        const minScale = Math.max(minScaleX, minScaleY, 0.3);
        t_scale = Math.max(minScale, Math.min(t_scale, 8));

        // 2. Constrain Panning: Stop exactly at the edges of the scaled grid
        const scaledGridW = GRID_W * t_scale;
        const scaledGridH = GRID_H * t_scale;

        // Absolute maximum panning allowed before the void shows
        const maxPanX = Math.max(0, (scaledGridW - w) / 2);
        const maxPanY = Math.max(0, (scaledGridH - h) / 2);

        // Shift the panning boundaries by the Safe Area offset!
        // This prevents the camera from sliding into the void when a panel pushes it.
        const minX = -maxPanX - lastSafeOffsetX;
        const maxX = maxPanX - lastSafeOffsetX;
        const minY = -maxPanY - lastSafeOffsetY;
        const maxY = maxPanY - lastSafeOffsetY;

        // Save the old values to detect if we hit a wall
        const oldPanX = t_panX;
        const oldPanY = t_panY;

        // Force targets and current pan values to stay strictly inside the shifted box
        targetPanX = Math.max(minX, Math.min(maxX, targetPanX));
        targetPanY = Math.max(minY, Math.min(maxY, targetPanY));
        t_panX = Math.max(minX, Math.min(maxX, t_panX));
        t_panY = Math.max(minY, Math.min(maxY, t_panY));

        // Prevent drag desync: If the user is dragging against the hard wall,
        // update the anchor coordinates so the grid instantly responds when they change direction!
        if (t_isDragging) {
            if (oldPanX !== t_panX) t_startX += (oldPanX - t_panX);
            if (oldPanY !== t_panY) t_startY += (oldPanY - t_panY);
        }
    }

    let transformPending = false;
    function applyTransform() {
        constrainView();
        if (transformPending) return;
        transformPending = true;

        requestAnimationFrame(() => {
            const zoomGroup = document.getElementById('tonnetz-zoom-group');
            if (zoomGroup) {
                const finalX = t_panX + lastSafeOffsetX;
                const finalY = t_panY + lastSafeOffsetY;

                // THE CHROME FIX: Strip the broken CSS and use native SVG math
                zoomGroup.style.transform = '';
                zoomGroup.style.willChange = 'auto';
                zoomGroup.setAttribute("transform", `translate(${finalX}, ${finalY}) scale(${t_scale})`);
            }
            updatePianoRange();
            transformPending = false;
        });
    }

    function centerOnRoot(animate = false) {
        // Because the offset is injected in applyTransform,
        // true center is ALWAYS mathematically (0,0)!
        targetPanX = 0;
        targetPanY = 0;

        if (animate) {
            if (!isAnimatingPan) { isAnimatingPan = true; animatePan(); }
        } else {
            t_panX = 0; t_panY = 0; applyTransform();
        }
    }

    // =========================================================
    // UI COLLISION ENGINE (Piano Roll vs Side Panels)
    // =========================================================
    function evaluatePanelCollisions() {
        const pr = document.getElementById('piano-roll-overlay');
        const activeLeftPanel = document.querySelector('.overlay.primary.active');
        const chordUI = document.getElementById('chord-display') || document.getElementById('chord-indicator');

        // Rule 1: Reset everything if we are in Portrait Mode, or if panels are closed
        if (window.innerWidth <= window.innerHeight || !activeLeftPanel) {
            document.documentElement.style.setProperty('--pr-left-offset', '0px');
            document.documentElement.style.setProperty('--chord-left-offset', '15px'); 
        
            if (activeLeftPanel) {
                activeLeftPanel.classList.remove('pr-collided');
                activeLeftPanel.style.removeProperty('height');
                activeLeftPanel.style.removeProperty('max-height');
                activeLeftPanel.style.removeProperty('border-bottom-left-radius');
                activeLeftPanel.style.removeProperty('border-bottom-right-radius');
            }
            return;
        }

        // --- 1. EVALUATE TRUE PIANO STATE ---
        const pianoOverlay = document.getElementById('piano-overlay');
        const isPianoVisible = pianoOverlay && pianoOverlay.classList.contains('active');
        const pianoH = isPianoVisible ? pianoOverlay.offsetHeight : 0;

        // --- 2. EVALUATE PIANO ROLL TARGET ---
        const isPrActive = pr && pr.classList.contains('active');
        let prTargetTop = window.innerHeight;
        if (isPrActive) {
            prTargetTop = window.innerHeight - pr.offsetHeight - pianoH;
        }

        // --- 3. MEASURE STRUCTURAL BOUNDARIES ---
        // CRITICAL FIX: Use offsetTop/offsetWidth to completely bypass CSS transform animations!
        const initialTop = activeLeftPanel.offsetTop;
        const panelWidth = activeLeftPanel.offsetWidth;

        const spaceToFloor = window.innerHeight - initialTop - pianoH;
        const spaceAbovePR = prTargetTop - initialTop;

        activeLeftPanel.classList.remove('pr-collided');
        activeLeftPanel.style.removeProperty('height');
        activeLeftPanel.style.removeProperty('max-height');
        activeLeftPanel.style.removeProperty('border-bottom-left-radius');
        activeLeftPanel.style.removeProperty('border-bottom-right-radius');

        // scrollHeight calculates the true internal content height
        const naturalContentHeight = activeLeftPanel.scrollHeight;

        // --- 4. APPLY COLLISION LOGIC ---
        if (isPrActive && naturalContentHeight > spaceAbovePR) { 
            // 1. Move Piano Roll to the right
            document.documentElement.style.setProperty('--pr-left-offset', `${panelWidth}px`);
            activeLeftPanel.classList.add('pr-collided');
        
            // 2. Force panel to stretch to the floor
            activeLeftPanel.style.setProperty('max-height', `${spaceToFloor}px`, 'important');
            activeLeftPanel.style.setProperty('height', `${spaceToFloor}px`, 'important');
            activeLeftPanel.style.setProperty('border-bottom-left-radius', '0', 'important');
            activeLeftPanel.style.setProperty('border-bottom-right-radius', '0', 'important');

        } else {
            document.documentElement.style.setProperty('--pr-left-offset', '0px');
        
            if (!isPrActive) {
                // Allow the panel to reach the floor naturally if PR is closed
                activeLeftPanel.style.setProperty('max-height', `${spaceToFloor}px`, 'important');
            } else {
                activeLeftPanel.style.removeProperty('max-height');
            }
        }

        // --- 5. CHORD UI COLLISION ---
        if (chordUI) {
            // offsetHeight correctly reports the final physical height AFTER our CSS injections
            const panelBottom = initialTop + activeLeftPanel.offsetHeight;
            const chordTopY = window.innerHeight - pianoH - 85; 
        
            if (panelBottom > chordTopY) {
                // CRITICAL FIX: Calculate the right edge using purely structural layout math!
                const panelRightEdge = activeLeftPanel.offsetLeft + panelWidth;
                document.documentElement.style.setProperty('--chord-left-offset', `${panelRightEdge + 15}px`);
            } else {
                document.documentElement.style.setProperty('--chord-left-offset', '15px'); 
            }
        }
    }

    const overlayObserver = new ResizeObserver(() => updateOverlayCSSVars());
    ['settings-overlay', 'synth-overlay', 'pads-overlay', 'drums-overlay', 'looper-overlay'].forEach(id => { const el = document.getElementById(id); if (el) overlayObserver.observe(el); });

    let activeUserNotes = 0, navFadeTimeout = null, uiHideDelay = isMobileDevice ? 1000 : 0;
    const navEl = document.getElementById('canvas-controls');


    function toggleOverlay(type) {
        wakeNav();
        closeFabMenu();

        // 1. Independent Panels (Floaters that return immediately)
        if (type === 'info') { isInfoActive = !isInfoActive; document.getElementById('info-overlay')?.classList.toggle('active', isInfoActive); document.getElementById('btnInfo')?.classList.toggle('toggled', isInfoActive); return; }
        
        if (type === 'gen') { 
            isGenActive = !isGenActive; 
            
            // --- MUTUAL EXCLUSIVITY: Close Humanize if opening Gen ---
            if (isGenActive) {
                isHumanizeActive = false;
                document.getElementById('humanize-overlay')?.classList.remove('active');
                document.getElementById('btnToggleHumanize')?.classList.remove('active');
            }

            document.getElementById('gen-overlay')?.classList.toggle('active', isGenActive); 
            document.getElementById('btnToggleGenPr')?.classList.toggle('active', isGenActive); 
                
            // AI Scale Warning 
            if (isGenActive) {
                const scaleWarning = document.getElementById('genScaleWarning');
                if (scaleWarning) {
                    const isChromatic = !currentScale || currentScale === 'all' || currentScale === 'chromatic';
                    scaleWarning.style.display = isChromatic ? 'inline' : 'none';
                }
            }
            evaluatePanelCollisions();
            return; 
        }

        if (type === 'humanize') {
            isHumanizeActive = !isHumanizeActive;
            
            // --- MUTUAL EXCLUSIVITY: Close Gen if opening Humanize ---
            if (isHumanizeActive) {
                isGenActive = false;
                document.getElementById('gen-overlay')?.classList.remove('active');
                document.getElementById('btnToggleGenPr')?.classList.remove('active');
            }

            document.getElementById('humanize-overlay')?.classList.toggle('active', isHumanizeActive);
            document.getElementById('btnToggleHumanize')?.classList.toggle('active', isHumanizeActive);
            return;
        }
        if (type === 'bounce') {
            isBounceActive = !isBounceActive;
            if (isBounceActive) {
                if (typeof isGenActive !== 'undefined' && isGenActive) toggleOverlay('gen');
                if (typeof isHumanizeActive !== 'undefined' && isHumanizeActive) toggleOverlay('humanize');
                if (typeof isExportActive !== 'undefined' && isExportActive) toggleOverlay('export');
            }
            document.getElementById('bounce-overlay')?.classList.toggle('active', isBounceActive);
            if (typeof evaluatePanelCollisions === 'function') evaluatePanelCollisions();
            return;
        }
    
        if (type === 'export') {
            isExportActive = !isExportActive;
            if (isExportActive) {
                if (typeof isGenActive !== 'undefined' && isGenActive) toggleOverlay('gen');
                if (typeof isHumanizeActive !== 'undefined' && isHumanizeActive) toggleOverlay('humanize');
                if (typeof isBounceActive !== 'undefined' && isBounceActive) toggleOverlay('bounce'); // Close bounce if opening export
            }
            document.getElementById('export-overlay')?.classList.toggle('active', isExportActive);
            if (typeof evaluatePanelCollisions === 'function') evaluatePanelCollisions();
            return;
        }
        if (type === 'piano') {
            isPianoActive = !isPianoActive;
            document.getElementById('piano-overlay')?.classList.toggle('active', isPianoActive);
            const btn = document.getElementById('btnTogglePiano');
            if (btn) {
                btn.classList.toggle('toggled', isPianoActive);
                btn.classList.toggle('active', isPianoActive); 
            }
            document.getElementById('chord-display')?.classList.toggle('piano-active', isPianoActive);
            document.documentElement.style.setProperty('--piano-h', isPianoActive ? 'clamp(80px, 16vh, 140px)' : '0px');
            updateOverlayCSSVars();
            return;
        }
        if (type === 'pianoRoll') {
            isPianoRollActive = !isPianoRollActive;
            const prEl = document.getElementById('piano-roll-overlay');
            const btn = document.getElementById('btnTogglePianoRoll');
            
            if (prEl) prEl.classList.toggle('active', isPianoRollActive);
            if (btn) btn.classList.toggle('toggled', isPianoRollActive);
            
            // Allow CSS to push the D-Pad upward
            document.body.classList.toggle('pr-open', isPianoRollActive);
            
            // THE FIX: Explicitly broadcast the fallback height immediately so other panels yield!
            document.documentElement.style.setProperty('--pr-actual-h', isPianoRollActive ? 'var(--pr-height, 30vh)' : '0px');
            
            // Delay rendering by 100ms to allow CSS animation to open the panel
            if (isPianoRollActive) {
                setTimeout(() => { if (typeof drawPianoRoll === 'function') drawPianoRoll(); }, 100);
            }
            updateOverlayCSSVars();
            return;
        }
        if (type === 'macros') {
            isMacroActive = !isMacroActive;
            const panel = document.getElementById('macro-overlay');
            const btn = document.getElementById('btnToggleMacros');
            
            if (panel) panel.classList.toggle('active', isMacroActive);
            if (btn) btn.classList.toggle('toggled', isMacroActive);

            // Tell the CSS engine the shelf is active so top-docked panels yield!
            if (isMacroActive && panel) {
                document.documentElement.style.setProperty('--macro-height', `${panel.offsetHeight}px`);
            } else {
                document.documentElement.style.setProperty('--macro-height', `0px`);
            }
            
            updateOverlayCSSVars(); 
            return;
        }

        // 2. Standard DAW Panels Configuration Map
        const panels = {
            settings: { overlay: 'settings-overlay', btn: 'btnToggleSettings', side: 'left',  get: () => isSettingsActive, set: v => isSettingsActive = v },
            synth:    { overlay: 'synth-overlay',    btn: 'btnToggleSynth',    side: 'left',  get: () => isSynthActive,    set: v => { isSynthActive = v; if(v) drawEnvelope(); } },
            pads:     { overlay: 'pads-overlay',     btn: 'btnTogglePads',     side: 'left',  get: () => isPadsActive,     set: v => isPadsActive = v },
            drums:    { overlay: 'drums-overlay',    btn: 'btnToggleDrums',    side: 'left',  get: () => isDrumsActive,    set: v => isDrumsActive = v },
            mixer:    { overlay: 'mixer-overlay',    btn: 'btnToggleMixer',    side: 'left',  get: () => isMixerActive,    set: v => isMixerActive = v },
        };

        const target = panels[type];
        if (!target) return; // Failsafe abort if panel doesn't exist

        // 3. Layout Exclusivity (The Traffic Cop)
        if (!target.get()) { // Only trigger auto-close rules if we are OPENING a panel
            const isPortrait = window.innerHeight > window.innerWidth;
            Object.keys(panels).forEach(p => {
                // If on mobile (portrait), close ALL others. If on desktop, close only panels on the SAME side.
                if (p !== type && (isPortrait || panels[p].side === target.side)) {
                    panels[p].set(false);
                    document.getElementById(panels[p].overlay)?.classList.remove('active');
                    document.getElementById(panels[p].btn)?.classList.remove('toggled');
                }
            });
        }

        // 4. Toggle the requested panel
        const newState = !target.get();
        target.set(newState);
        document.getElementById(target.overlay)?.classList.toggle('active', newState);
        document.getElementById(target.btn)?.classList.toggle('toggled', newState);

        updateOverlayCSSVars();
    }

    function toggleCof() {
        wakeNav(); isCofActive = !isCofActive;
        const cofOverlay = document.getElementById('cof-overlay'); const btn = document.getElementById('btnToggleCOF');
        if (isCofActive) { if (cofOverlay) cofOverlay.classList.add('active'); if (btn) btn.classList.add('toggled'); }
        else { if (cofOverlay) cofOverlay.classList.remove('active'); if (btn) btn.classList.remove('toggled'); }
    }

    function wakeNav() {
        if (activeUserNotes > 0 && !t_isDragging) return;
        clearTimeout(navFadeTimeout);

        const wasHidden = document.body.classList.contains('ui-hidden');
        document.body.classList.remove('ui-hidden');

        // If the UI was asleep, wake it up and recalculate the Tonnetz Safe Area!
        if (wasHidden) updateOverlayCSSVars();
    }

    function hideNav() {
        if (uiHideDelay === 0) return; // Auto-hide is turned OFF

        const wasHidden = document.body.classList.contains('ui-hidden');
        document.body.classList.add('ui-hidden');

        // Tell the Tonnetz Safe Area that the panels are gone!
        if (!wasHidden) updateOverlayCSSVars();
    }

    // --- AUTO-HIDE TOGGLE LISTENERS ---
    document.querySelectorAll('.auto-hide-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Explicitly include all panel IDs that might lack the .overlay class
            const overlay = e.target.closest('.overlay, #piano-roll-overlay, #macro-overlay');
            if (overlay) {
                const isAuto = overlay.classList.toggle('auto-hides');
                e.target.classList.toggle('active', isAuto);
                e.target.title = isAuto ? "Auto-Hide Enabled" : "Auto-Hide Disabled";
                
                // Recalculate heights/widths in case this panel just got pinned/unpinned!
                updateOverlayCSSVars();
            }
        });
    });

    // --- FAB MENU LOGIC ---
    function closeFabMenu() {
        const cc = document.getElementById('canvas-controls');
        const btn = document.getElementById('btnNavToggle');
        if (cc && cc.classList.contains('menu-open')) {
            cc.classList.remove('menu-open');
            if (btn) { btn.textContent = '🛠️'; btn.style.transform = 'rotate(0deg)'; }
        }
    }

    document.getElementById('btnNavToggle')?.addEventListener('click', (e) => {
        const cc = document.getElementById('canvas-controls');
        const btn = e.target;
        cc.classList.toggle('menu-open');
        if (cc.classList.contains('menu-open')) {
            btn.textContent = '✕';
            btn.style.transform = 'rotate(90deg)';
        } else {
            btn.textContent = '🛠️';
            btn.style.transform = 'rotate(0deg)';
        }
    });

    document.getElementById('btnToggleSettings')?.addEventListener('click', () => toggleOverlay('settings'));
    document.getElementById('btnToggleSynth')?.addEventListener('click', () => toggleOverlay('synth'));
    document.getElementById('btnTogglePads')?.addEventListener('click', () => toggleOverlay('pads'));
    document.getElementById('btnToggleDrums')?.addEventListener('click', () => toggleOverlay('drums'));
    document.getElementById('btnToggleMacros')?.addEventListener('click', () => toggleOverlay('macros'));
    document.getElementById('btnTogglePianoRoll')?.addEventListener('click', () => toggleOverlay('pianoRoll'));
    document.getElementById('btnTogglePiano')?.addEventListener('click', () => toggleOverlay('piano'));
    document.getElementById('btnToggleCOF')?.addEventListener('click', toggleCof);
    document.getElementById('btnToggleMixer')?.addEventListener('click', () => toggleOverlay('mixer'));
    document.getElementById('btnQuickPanic')?.addEventListener('click', executePanic);
    document.getElementById('btnToggleGenPr')?.addEventListener('click', () => toggleOverlay('gen'));

    document.getElementById('btnCloseSettings')?.addEventListener('click', () => toggleOverlay('settings'));
    document.getElementById('btnCloseSynth')?.addEventListener('click', () => toggleOverlay('synth'));
    document.getElementById('btnClosePads')?.addEventListener('click', () => toggleOverlay('pads'));
    document.getElementById('btnCloseDrums')?.addEventListener('click', () => toggleOverlay('drums'));
    document.getElementById('btnClosePianoRoll')?.addEventListener('click', () => toggleOverlay('pianoRoll'));
    document.getElementById('btnCloseCOF')?.addEventListener('click', toggleCof);
    document.getElementById('btnCloseInfo')?.addEventListener('click', () => toggleOverlay('info'));
    document.getElementById('btnInfo')?.addEventListener('click', () => toggleOverlay('info'));
    document.getElementById('btnCloseMixer')?.addEventListener('click', () => toggleOverlay('mixer'));
    document.getElementById('btnCloseGen')?.addEventListener('click', () => toggleOverlay('gen'));

    document.getElementById('btnSavePreset')?.addEventListener('click', () => {
        const s = {
            keyCenter: document.getElementById('keyCenter').value, scaleOverlay: document.getElementById('scaleOverlay').value, labelType: document.getElementById('labelType').value,
            transpose: document.getElementById('transpose').value, tuningMode: document.getElementById('tuningMode').value, arpBpm: document.getElementById('arpBpm').value,
            arpRhythm: document.getElementById('arpRhythm').value, arpSwing: document.getElementById('arpSwing').value, arpLoop: document.getElementById('arpLoop').value, drumPreset: currentDrumPreset,
            themeColorSelect: document.getElementById('themeColorSelect')?.value, masterTune: document.getElementById('masterTune').value, bgEffectMode: bgEffectMode, bgIntensity: bgEffectIntensity,
            uiHideDelay: document.getElementById('uiHideDelay').value, instrumentPreset: document.getElementById('instrumentPreset').value,
            attack: document.getElementById('attack').value, decay: document.getElementById('decay').value, sustain: document.getElementById('sustain').value, release: document.getElementById('release').value,
            brightness: document.getElementById('brightness').value, resonance: document.getElementById('resonance').value, chorus: document.getElementById('chorus').value, distortion: document.getElementById('distortion').value,
            echo: document.getElementById('echo').value, reverbMix: document.getElementById('reverbMix').value, lfoSpeed: document.getElementById('lfoSpeed').value, vibrato: document.getElementById('vibrato').value,
            lfoShape: currentLfoShape, lfoSync: currentLfoSync, lfoRetrigger: lfoRetrigger,
            lfoDelay: currentLfoDelay, lfoFade: currentLfoFade, lfoKeytrack: currentLfoKeytrack, lfoPolarity: currentLfoPolarity,
            tremolo: document.getElementById('tremolo').value, sweep: document.getElementById('sweep').value, detune: document.getElementById('detune').value, subOsc: document.getElementById('subOsc').value,
            noise: document.getElementById('noise').value, filterEnv: document.getElementById('filterEnv').value, padHeight: document.getElementById('padHeightSlider').value, drumHeight: document.getElementById('drumHeightSlider').value,
            overtones: document.getElementById('overtones').value,
            masterVol: document.getElementById('masterVol').value, synthVol: document.getElementById('synthVol').value, drumVol: document.getElementById('drumVol').value, looperVCA: document.getElementById('looperVCA').value, mixerImportVol: document.getElementById('mixerImportVol').value, eqLow: document.getElementById('eqLow').value, eqMid: document.getElementById('eqMid').value, eqHigh: document.getElementById('eqHigh').value,
            oscMix: document.getElementById('oscMix').value, glide: document.getElementById('glide').value, filterType: document.getElementById('filterType').value,
            midiVelocity: document.getElementById('midiVelocity').value,
            looperLength: document.getElementById('looperLength').value,
            looperTrackVols: Array.from(document.querySelectorAll('.track-vol')).map(el => el.value),
            looperEchoSends: Array.from(document.querySelectorAll('.echo-send')).map(el => el.value),
            looperReverbSends: Array.from(document.querySelectorAll('.reverb-send')).map(el => el.value),
            looperTrackPans: Array.from(document.querySelectorAll('.pan-slider')).map(el => el.value),
            trackMutes: Array.from(document.querySelectorAll('.mute-btn:not(.solo-btn):not(.edit-btn)')).map(el => el.classList.contains('muted')),
            autoHidePanels: Array.from(document.querySelectorAll('.overlay, #piano-roll-overlay, #macro-overlay')).filter(el => el.classList.contains('auto-hides')).map(el => el.id),
            busComp: document.getElementById('busComp').value,
            mixerHeightSlider: document.getElementById('mixerHeightSlider').value,
            limiterMode: document.getElementById('limiterMode').value,
            autoPan: currentAutoPan,
            glideMode: currentGlideMode,
            midiSyncMode: midiSyncMode,
            looperQuantize: looperQuantize, looperQuantizeRes: looperQuantizeRes,
            declick: document.getElementById('declick').value
        };
        const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'TonnetzPro_Settings.json'; a.click(); URL.revokeObjectURL(url); showToast("Settings saved to file.");
    });

    document.getElementById('btnLoadPreset')?.addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const s = JSON.parse(ev.target.result);
                    const av = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) { el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); } };

                    // REMOVED Custom Buttons from this array! Only true standard inputs remain here.
                    ['keyCenter', 'scaleOverlay', 'labelType', 'transpose', 'tuningMode', 'arpBpm', 'arpRhythm', 'arpSwing', 'arpLoop', 'themeColorSelect', 'masterTune', 'uiHideDelay', 'instrumentPreset', 'attack', 'decay', 'sustain', 'release', 'brightness', 'resonance', 'chorus', 'distortion', 'echo', 'reverbMix', 'lfoSpeed', 'vibrato', 'tremolo', 'sweep', 'detune', 'subOsc', 'noise', 'filterEnv', 'masterVol', 'synthVol', 'drumVol', 'looperVCA', 'mixerImportVol', 'eqLow', 'eqMid', 'eqHigh', 'oscMix', 'glide', 'filterType', 'midiVelocity', 'looperLength', 'busComp', 'mixerHeightSlider', 'limiterMode', 'overtones', 'bgEffectMode', 'bgIntensity', 'declick', 'lfoDelay', 'lfoFade', 'lfoKeytrack'].forEach(k => av(k, s[k]));

                    av('padHeightSlider', s.padHeight);
                    av('drumHeightSlider', s.drumHeight);

                    // --- FIX: EXPLICIT BUTTON STATE RESTORATION ---
                    if (s.lfoShape !== undefined) { currentLfoShape = s.lfoShape; const b = document.getElementById('btnLfoShape'); if (b) b.textContent = `Shape: ${currentLfoShape.toUpperCase()}`; }
                    if (s.lfoSync !== undefined) { currentLfoSync = s.lfoSync; const b = document.getElementById('btnLfoSync'); if (b) b.textContent = `Rate: ${currentLfoSync === 'hz' ? 'Hz' : 'BEAT'}`; }
                    if (s.lfoPolarity !== undefined) { currentLfoPolarity = s.lfoPolarity; const pEl = document.getElementById('lfoPolarity'); if (pEl) pEl.value = currentLfoPolarity; }
                    if (s.glideMode !== undefined) { currentGlideMode = s.glideMode; const b = document.getElementById('btnGlideMode'); if (b) b.textContent = `Glide: ${currentGlideMode.toUpperCase()}`; }
                    if (s.autoPan !== undefined) { currentAutoPan = s.autoPan; const b = document.getElementById('btnAutoPan'); if (b) { b.textContent = `Auto-Pan: ${currentAutoPan === 'off' ? 'OFF' : currentAutoPan.toUpperCase()}`; b.classList.toggle('active-btn', currentAutoPan !== 'off'); } }
                    if (s.midiSyncMode !== undefined) { midiSyncMode = s.midiSyncMode; const b = document.getElementById('btnMidiSync'); if (b) { b.textContent = `Sync: ${midiSyncMode.toUpperCase()}`; b.classList.toggle('active-btn', midiSyncMode === 'external'); } }
                    if (s.looperQuantizeRes !== undefined) { looperQuantizeRes = s.looperQuantizeRes; const b = document.getElementById('btnQuantizeRes'); const lbls = { 0.25: '1/16', 0.5: '1/8', 1: '1/4' }; if (b) b.textContent = `Res: ${lbls[looperQuantizeRes] || '1/16'}`; }

                    // restore LFO Retrigger button
                    if (s.lfoRetrigger !== undefined && lfoRetrigger !== s.lfoRetrigger) {
                        lfoRetrigger = s.lfoRetrigger;
                        const btnReq = document.getElementById('btnLfoRetrigger');
                        if (btnReq) {
                            btnReq.textContent = `Key Sync: ${lfoRetrigger ? 'ON' : 'OFF'}`;
                            btnReq.classList.toggle('active-btn', lfoRetrigger);
                        }
                    }

                    // Restore Quantization Button state
                    if (s.looperQuantize !== undefined && looperQuantize !== s.looperQuantize) {
                        looperQuantize = s.looperQuantize;
                        const btnQ = document.getElementById('btnLooperQuantize');
                        if (btnQ) {
                            btnQ.textContent = `Input Snap: ${looperQuantize ? 'ON' : 'OFF'}`;
                            btnQ.classList.toggle('active-btn', looperQuantize);
                        }
                    }

                    // Restore the drum preset
                    const presetToLoad = s.drumPreset || 'none';
                    updateDrumUI(presetToLoad);

                    if (s.showExtensions !== undefined && showExtensions !== s.showExtensions) { showExtensions = s.showExtensions; document.getElementById('btnExtensions').textContent = `7th/9th Ext. Highlights: ${showExtensions ? 'ON' : 'OFF'}`; document.getElementById('btnExtensions').classList.toggle('active-btn', showExtensions); updateHighlights(); }
                    if (s.showChordDegrees !== undefined && showChordDegrees !== s.showChordDegrees) { showChordDegrees = s.showChordDegrees; document.getElementById('btnChordDegrees').textContent = `Show Chord Degrees: ${showChordDegrees ? 'ON' : 'OFF'}`; document.getElementById('btnChordDegrees').classList.toggle('active-btn', showChordDegrees); updatePianoVisuals(); }
                    if (s.isDarkMode !== undefined && isDarkMode !== s.isDarkMode) { isDarkMode = s.isDarkMode; document.body.classList.toggle('dark-theme', isDarkMode); document.getElementById('btnTheme').textContent = `Dark Mode: ${isDarkMode ? 'ON' : 'OFF'}`; document.getElementById('btnTheme').classList.toggle('active-btn', isDarkMode); }

                    // --- RESTORE 16-TRACK MIXER SETTINGS ---
                    if (s.looperTrackVols) { document.querySelectorAll('.track-vol').forEach((el, idx) => { if (s.looperTrackVols[idx] !== undefined) { el.value = s.looperTrackVols[idx]; el.dispatchEvent(new Event('input')); } }); }
                    if (s.looperTrackPans) { document.querySelectorAll('.pan-slider').forEach((el, idx) => { if (s.looperTrackPans[idx] !== undefined) { el.value = s.looperTrackPans[idx]; el.dispatchEvent(new Event('input')); } }); }
                    if (s.looperEchoSends) { document.querySelectorAll('.echo-send').forEach((el, idx) => { if (s.looperEchoSends[idx] !== undefined) { el.value = s.looperEchoSends[idx]; el.dispatchEvent(new Event('input')); } }); }
                    if (s.looperReverbSends) { document.querySelectorAll('.reverb-send').forEach((el, idx) => { if (s.looperReverbSends[idx] !== undefined) { el.value = s.looperReverbSends[idx]; el.dispatchEvent(new Event('input')); } }); }

                    // Restore Mute States safely via click events to ensure audio engine updates
                    if (s.trackMutes) {
                        document.querySelectorAll('.mute-btn:not(.solo-btn):not(.edit-btn)').forEach((el, idx) => {
                            if (s.trackMutes[idx]) {
                                if (!el.classList.contains('muted')) el.click();
                            } else {
                                if (el.classList.contains('muted')) el.click();
                            }
                        });
                    }

                    // --- RESTORE AUTO-HIDE PANEL PREFERENCES ---
                    if (s.autoHidePanels) {
                        document.querySelectorAll('.overlay, #piano-roll-overlay, #macro-overlay').forEach(el => {
                            const shouldHide = s.autoHidePanels.includes(el.id);
                            el.classList.toggle('auto-hides', shouldHide);
                            const btn = el.querySelector('.auto-hide-toggle');
                            if (btn) {
                                btn.classList.toggle('active', shouldHide);
                                btn.title = shouldHide ? "Auto-Hide Enabled" : "Auto-Hide Disabled";
                            }
                        });
                    }

                    // Explicitly sync the Macro Dashboard!
                    if (typeof syncAllMacros === 'function') syncAllMacros();

                    showToast("Settings loaded successfully.");
                } catch (err) { showToast("Error loading preset file."); }
            }; reader.readAsText(file);
        }; inp.click();
    });

    // --- HARMONIC HEATMAP STATE & PROFILES ---
    let isHeatmapActive = false;
    let currentHeatmapProfile = 'off';
    let heatmapBaseNotes = [];

    // Psychoacoustic tunings across different musical eras
    const heatmapProfiles = {
        classical: { // Strict counterpoint. Extensions are tense.
            0: 0.0, 1: 1.0, 2: 0.5, 3: 0.2, 4: 0.1, 5: 0.2,
            6: 1.0, 7: 0.0, 8: 0.6, 9: 0.3, 10: 0.5, 11: 0.9
        },
        pop: { // 7ths and 9ths are slightly safer, but still have pull.
            0: 0.0, 1: 1.0, 2: 0.35, 3: 0.2, 4: 0.1, 5: 0.15,
            6: 0.85, 7: 0.0, 8: 0.5, 9: 0.2, 10: 0.4, 11: 0.6
        },
        jazz: { // Neo-Soul/Modern. Major 7ths and 9ths are highly stable chord tones.
            0: 0.0, 1: 1.0, 2: 0.25, 3: 0.2, 4: 0.1, 5: 0.15,
            6: 0.75, 7: 0.0, 8: 0.45, 9: 0.15, 10: 0.3, 11: 0.4
        }
    };

    document.getElementById('heatmapProfile')?.addEventListener('change', (e) => {
        currentHeatmapProfile = e.target.value;
        isHeatmapActive = (currentHeatmapProfile !== 'off');

        // Toggle active styling on the dropdown to match other buttons
        e.target.classList.toggle('active-btn', isHeatmapActive);

        if (!isHeatmapActive) {
            // Clean slate when turned off
            if (cachedGridNodes) {
                for (let i = 0; i < cachedGridNodes.length; i++) {
                    cachedGridNodes[i].style.removeProperty('fill');
                    cachedGridNodes[i].style.removeProperty('opacity');
                    if (cachedGridNodes[i]._highlightEl) {
                        cachedGridNodes[i]._highlightEl.classList.remove('gravity-border-local', 'gravity-border-sequence');
                    }
                }
            }
            // --- NEW: Clean the text nodes too ---
            if (cachedTextNodes) {
                for (let i = 0; i < cachedTextNodes.length; i++) {
                    cachedTextNodes[i].classList.remove('gravity-text-local', 'gravity-text-sequence');
                }
            }
            heatmapBaseNotes = [];
            rootHistory = []; // Clear chord history on disable
        } else if (heatmapBaseNotes.length > 0) {
            updateHarmonicHeatmap();
        }
    });

    // =======================================================
    // DYNAMIC ARRANGER ARCHITECTURE & MASTER CONTROLS
    // =======================================================

    // --- 1. FACTORY: ADD 8 TRACKS ---
    document.getElementById('btnAddArrangerBank')?.addEventListener('click', () => {
        // --- NEW: Soft Warning instead of a Hard Limit ---
        if (currentArrangerTrackCount === 64) {
            showToast("⚠️ High track count. If audio stutters, consider bouncing tracks.", "warning");
        }

        const startLocalIdx = currentArrangerTrackCount;
        const startGlobalIdx = startLocalIdx + 8;
        currentArrangerTrackCount += 8;

        // 1. Expand Audio & State Arrays
        for (let i = 0; i < 8; i++) {
            arranger.tracks.push([]);
            arranger.muted.push(false);
            arranger.soloed.push(false);
            
            studio.trackTypes.push(null);
            studio.trackSynthStates.push(captureCurrentSynthState());
            studio.trackAudioBuffers.push(null);
        }

        // 2. Expand Web Audio Routing
        if (typeof audioCtx !== 'undefined' && audioCtx) {
            for (let i = 0; i < 8; i++) {
                let g = audioCtx.createGain(); g.gain.value = 1.0; linearGainNodes.push(g);
                let p = audioCtx.createStereoPanner(); p.pan.value = 0.0; linearPanners.push(p);

                g.connect(p);
                p.connect(synthGain); // Default to Synth Bus

                let eSend = audioCtx.createGain(); eSend.gain.value = 0;
                g.connect(eSend); linearEchoSends.push(eSend); eSend.connect(delayNode);

                let rSend = audioCtx.createGain(); rSend.gain.value = 0;
                g.connect(rSend); linearReverbSends.push(rSend); rSend.connect(convolver);
            }
        }

        // 3. Inject DOM Elements
        const grid = document.getElementById('arranger-mixer-grid');
        if (grid) {
            let newHTML = "";
            for (let i = 0; i < 8; i++) {
                const localIdx = startLocalIdx + i;
                const globalIdx = startGlobalIdx + i;
                newHTML += `
                <div style="display: flex; flex-direction: column; gap: 4px;" class="new-track-strip">
                    <div class="inst-label" id="inst-label-${globalIdx}" style="text-align: center; font-size: 0.55rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: -2px;">EMPTY</div>
                    <button class="track-btn" data-track="${globalIdx}" data-domain="arranger" style="width: 100%; margin: 0; padding: 4px 0;">A${localIdx + 1}</button>
                    <div class="mixer-channel" style="margin: 0; padding-top: 4px;">
                        <div style="display:flex; justify-content: space-between; gap:2px; width: 100%; margin-bottom: 6px;">
                            <button class="mute-btn" data-track="${globalIdx}" title="Mute" style="flex: 1; padding: 2px 0; font-size: 0.6rem;">M</button>
                            <button class="mute-btn solo-btn" data-track="${globalIdx}" title="Solo" style="flex: 1; padding: 2px 0; font-size: 0.6rem;">S</button>
                        </div>
                        <input type="range" class="aux-send echo-send" data-track="${globalIdx}" min="0" max="1" step="0.01" value="0">
                        <input type="range" class="aux-send reverb-send" data-track="${globalIdx}" min="0" max="1" step="0.01" value="0">
                        <input type="range" class="aux-send pan-slider" data-track="${globalIdx}" min="-1" max="1" step="0.01" value="0">
                        <input type="range" orient="vertical" class="v-slider track-vol" data-track="${globalIdx}" min="0" max="1" step="0.01" value="1.0">
                    </div>
                </div>`;
            }
            grid.insertAdjacentHTML('beforeend', newHTML);

            // If you implemented the bindTrackButtonEvents function, bind the long-press to the new buttons
            grid.querySelectorAll('.new-track-strip .track-btn').forEach(btn => {
                if (typeof bindTrackButtonEvents === 'function') bindTrackButtonEvents(btn);
            });
            grid.querySelectorAll('.new-track-strip').forEach(el => el.classList.remove('new-track-strip'));
        }

        // 4. Update Header UI
        const headerText = document.getElementById('arranger-header-text');
        if (headerText) headerText.textContent = `ARRANGER TRACKS (A1-A${currentArrangerTrackCount})`;
    });

    // --- 2. CLEAR ALL ARRANGER TRACKS (2000ms Hold & Shrink) ---
    const btnClearAllArranger = document.getElementById('btnClearAllArranger');
    if (btnClearAllArranger) {
        let clearAllTimer = null;
        let justClearedAll = false;

        const startClearAll = (e) => {
            if (e.cancelable) e.preventDefault(); // Prevent mobile long-press menus
            justClearedAll = false;
            
            btnClearAllArranger.classList.add('clearing'); 
            
            clearAllTimer = setTimeout(() => {
                justClearedAll = true;
                
                // 1. Wipe the Base 8 Tracks (A1-A8)
                for (let i = 0; i < 8; i++) {
                    arranger.tracks[i] = [];
                    studio.trackAudioBuffers[i + 8] = null;
                    studio.trackTypes[i + 8] = null;
                    
                    const el = document.getElementById(`inst-label-${i + 8}`);
                    if (el) el.textContent = 'EMPTY';
                    
                    const btn = document.querySelector(`.track-btn[data-track="${i + 8}"]`);
                    if (btn) btn.classList.remove('type-voice', 'type-drum');
                }

                // 2. Destroy and Shrink Tracks A9+ (Garbage Collection)
                if (currentArrangerTrackCount > 8) {
                    // Disconnect Web Audio Nodes from the hardware to free up CPU/RAM
                    for (let i = 8; i < currentArrangerTrackCount; i++) {
                        try {
                            if (linearGainNodes[i]) linearGainNodes[i].disconnect();
                            if (linearPanners[i]) linearPanners[i].disconnect();
                            if (linearEchoSends[i]) linearEchoSends[i].disconnect();
                            if (linearReverbSends[i]) linearReverbSends[i].disconnect();
                        } catch (err) { } // Catch any routing edge-cases gracefully
                    }

                    // Truncate all audio arrays back to length 8
                    arranger.tracks.length = 8;
                    arranger.muted.length = 8;
                    arranger.soloed.length = 8;
                    
                    linearGainNodes.length = 8;
                    linearPanners.length = 8;
                    linearEchoSends.length = 8;
                    linearReverbSends.length = 8;
                    
                    // The global Studio arrays hold 16 items total (8 Looper + 8 Arranger)
                    studio.trackTypes.length = 16; 
                    studio.trackSynthStates.length = 16;
                    studio.trackAudioBuffers.length = 16;

                    // Remove dynamically added DOM elements from the grid
                    const grid = document.getElementById('arranger-mixer-grid');
                    if (grid) {
                        // Keep exactly the first 8 default children, destroy the rest!
                        while (grid.children.length > 8) {
                            grid.removeChild(grid.lastChild);
                        }
                    }

                    currentArrangerTrackCount = 8;
                    
                    // Reset Header Text
                    const headerText = document.getElementById('arranger-header-text');
                    if (headerText) headerText.textContent = `ARRANGER TRACKS (A1-A8)`;
                }

                // --- Reset the pointer if it was on a destroyed track! ---
                if (studio.activeArrangerTrack >= 16) {
                    studio.activeArrangerTrack = 8; // Reset back to A1
                    
                    // Visually highlight the A1 button again
                    document.querySelectorAll('.track-btn').forEach(b => b.classList.remove('active'));
                    const a1Btn = document.querySelector('.track-btn[data-track="8"]');
                    if (a1Btn) a1Btn.classList.add('active');
                }

                // 3. Reset Global Arranger Clocks
                arranger.duration = 0;
                arranger.pauseTime = 0;

                const masterSeeker = document.getElementById('global-timeline-seeker');
                if (masterSeeker) masterSeeker.value = 0;
                
                // rewire audio cabling
                if (typeof syncAllTrackRouting === 'function') syncAllTrackRouting();

                // Force UI update
                if (typeof drawPianoRoll === 'function') drawPianoRoll();
                if (typeof updateStudioUI === 'function') updateStudioUI();
                
                showToast("All Arranger Tracks Cleared & Reset!");
                
                // 4. Visual Success Flash
                btnClearAllArranger.classList.remove('clearing');
                btnClearAllArranger.classList.add('cleared-flash');
                setTimeout(() => btnClearAllArranger.classList.remove('cleared-flash'), 300);

            }, 2000);
        };

        const cancelClearAll = () => {
            if (clearAllTimer) clearTimeout(clearAllTimer);
            btnClearAllArranger.classList.remove('clearing');
        };

        btnClearAllArranger.addEventListener('mousedown', startClearAll);
        btnClearAllArranger.addEventListener('mouseup', cancelClearAll);
        btnClearAllArranger.addEventListener('mouseleave', cancelClearAll);
        btnClearAllArranger.addEventListener('touchstart', startClearAll, { passive: false });
        btnClearAllArranger.addEventListener('touchend', cancelClearAll);
        btnClearAllArranger.addEventListener('touchcancel', cancelClearAll);
    }

    // =======================================================
    // 1. MIXER DESK & COMPRESSOR CONTROLS
    // =======================================================
    document.getElementById('mixerHeightSlider')?.addEventListener('input', (e) => { document.documentElement.style.setProperty('--mixer-fader-height', `${e.target.value}px`); updateOverlayCSSVars(); });
    document.getElementById('limiterMode')?.addEventListener('change', e => { updateSafetyCurve(e.target.value); });
    document.getElementById('busComp')?.addEventListener('input', e => { const val = parseFloat(e.target.value); updateLabel('busComp', val, 'Bus Comp', '%'); if (compressor) { compressor.threshold.value = isMobileDevice ? -15.0 : -4.0 - (val / 100 * 16); compressor.ratio.value = 1 + (val / 100 * 11); } });
    document.getElementById('declick')?.addEventListener('input', e => {
        currentDeclick = parseInt(e.target.value) / 1000; // Convert ms to seconds!
        updateLabel('declick', e.target.value, 'De-Click', 'ms');
    });

    let isMasterMixOn = true;
    document.getElementById('btn-import-mix-master')?.addEventListener('click', (e) => {
        isMasterMixOn = !isMasterMixOn;
        e.target.textContent = isMasterMixOn ? 'MIX: ON' : 'MIX: OFF';
        e.target.classList.toggle('active-btn', isMasterMixOn);
        updateImportedAudioMasterMix();
    });

    const fmtTime = (t) => {
        if (isNaN(t) || !isFinite(t)) return "0:00";
        return `${Math.floor(t / 60).toString()}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
    };

    // =======================================================
    // 2. SUBMIX & MASTER GAIN CONTROLLERS
    // =======================================================
    const bindSmoothFader = (sliderId, readoutId, getGainNode) => {
        document.getElementById(sliderId)?.addEventListener('input', e => {
            const val = parseFloat(e.target.value);
            const node = getGainNode(); // Fetch the exact node ONLY when slider moves!
            
            if (node && audioCtx) {
                node.gain.setTargetAtTime(val, audioCtx.currentTime, 0.015);
            }
            const readout = document.getElementById(readoutId);
            if (readout) readout.textContent = val.toFixed(2);
        });
    };

    // Wrapping the variables in () => passes a getter function instead of crashing on load
    bindSmoothFader('synthVol', 'valSynthVol', () => synthGain);
    bindSmoothFader('drumVol', 'valDrumVol', () => drumGain);
    bindSmoothFader('masterVol', 'valMasterVol', () => masterGain);
    bindSmoothFader('mixerImportVol', 'valMixerImportVol', () => importedAudioMasterGainNode);

    document.getElementById('looperVCA')?.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        const readout = document.getElementById('valLooperVCA');
        if (readout) readout.textContent = val.toFixed(2);
        updateMixerGains(); // VCA mathematically recalculates all 8 track volumes instantly!
    });

    // =======================================================
    // 3. MASTER EQ CONTROLS
    // =======================================================
    const updateEqReadout = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = `${val > 0 ? '+' : ''}${val}dB`; };
    
    const bindSmoothEQ = (sliderId, readoutId, getFilterNode) => {
        document.getElementById(sliderId)?.addEventListener('input', e => {
            const val = parseFloat(e.target.value);
            const node = getFilterNode(); // Fetch the exact node ONLY when slider moves!
            
            if (node && audioCtx) {
                node.gain.setTargetAtTime(val, audioCtx.currentTime, 0.015);
            }
            updateEqReadout(readoutId, val);
        });
    };

    bindSmoothEQ('eqLow', 'valEqLow', () => eqLow);
    bindSmoothEQ('eqMid', 'valEqMid', () => eqMid);
    bindSmoothEQ('eqHigh', 'valEqHigh', () => eqHigh);

    // =======================================================
    // 4. AUX SENDS: ECHO & REVERB (Anti-Zipper Smoothing)
    // =======================================================
    document.querySelectorAll('.echo-send').forEach(slider => {
        slider.addEventListener('input', e => {
            const trackIdx = parseInt(e.target.getAttribute('data-track'));
            const nodes = trackIdx < 8 ? looperEchoSends : linearEchoSends;
            const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
            if (nodes[localIdx] && audioCtx) {
                // Unified 1.0 scale (Matches Synth Knobs and initAudio)
                nodes[localIdx].gain.setTargetAtTime(parseFloat(e.target.value), audioCtx.currentTime, 0.015);
            }
        });
    });

    document.querySelectorAll('.reverb-send').forEach(slider => {
        slider.addEventListener('input', e => {
            const trackIdx = parseInt(e.target.getAttribute('data-track'));
            const nodes = trackIdx < 8 ? looperReverbSends : linearReverbSends;
            const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
            if (nodes[localIdx] && audioCtx) {
                // Unified 1.0 scale (Matches Synth Knobs and initAudio)
                nodes[localIdx].gain.setTargetAtTime(parseFloat(e.target.value), audioCtx.currentTime, 0.015);
            }
        });
    });

    // ==========================================
    // CAPACITOR / FULLSCREEN / PANIC LOGIC
    // ==========================================
    const isNativeApp = window.Capacitor && window.Capacitor.isNative;
    const btnFs = document.getElementById('btnFullscreen');

    async function executePanic() {
        wakeNav();

        // 1. Instantly kill all active audio nodes and clear arrays
        activeNodes.forEach(nodeData => { if (nodeData.voices) beginRelease(nodeData.voices, true, true); });
        sustainedVoices.forEach(nodeData => { if (nodeData.voices) beginRelease(nodeData.voices, true, true); });
        activeNodes.clear();
        sustainedVoices.clear();
        playingMidiNotes.clear();
        pianoExtensionNotes.clear();
        activeUserNotes = 0;

        // 2. Stop the Looper & Arranger
        looper.isPlaying = false;
        looper.isRecording = false;
        looper.isArmed = false;
        
        arranger.isPlaying = false;
        arranger.isRecording = false;
        arranger.isArmed = false;
        updateStudioUI();

        // 3. Clear runaway Delay/Echo loops
        if (feedbackGain && audioCtx) {
            try {
                const fbVol = parseFloat(document.getElementById('echo')?.value || 0.12);
                feedbackGain.gain.cancelScheduledValues(audioCtx.currentTime);
                feedbackGain.gain.setValueAtTime(0, audioCtx.currentTime);
                feedbackGain.gain.setTargetAtTime(fbVol, audioCtx.currentTime + 0.5, 0.05);
            } catch (e) { }
        }

        // 4. Send MIDI 'All Notes Off' (CC 123) to all 16 channels
        if (midiOut) {
            for (let c = 0; c < 16; c++) {
                midiOut.send([0xB0 + c, 123, 0]);
            }
        }

        // =======================================================
        // 5. NUCLEAR AUDIO REBOOT (Fixes Background Throttling)
        // =======================================================
        if (audioCtx) {
            // 1. Tell the hardware to close, but DO NOT await the promise!
            try {
                if (audioCtx.state !== 'closed') {
                    const oldCtx = audioCtx;
                    // THE FIX: Fire both asynchronously. Suspend aggressively releases 
                    // the hardware lock instantly, allowing the new context to boot safely!
                    oldCtx.suspend().catch(() => { });
                    oldCtx.close().catch(e => console.warn("AudioCtx close error:", e));
                }
            } catch (e) { 
                console.warn("Panic: AudioContext already closing.", e); 
            }

            console.log("AudioContext detached. Rebooting engine synchronously...");

            // 2. SYNCHRONOUS CLEANUP (Rescued from the .then() block)
            looperGainNodes = []; looperPanners = []; looperEchoSends = []; looperReverbSends = [];
            linearGainNodes = []; linearPanners = []; linearEchoSends = []; linearReverbSends = [];
            
            // --- THE CLOCK FIX ---
            nextMetronomeTick = 0;
            if (typeof nextMidiPulseTime !== 'undefined') nextMidiPulseTime = 0;
            lastVisualFrameTime = 0;
            // ---------------------

            metronomeGain = null;
            globalLfoOutput = null;
            lfoPanGain = null;
            sahShaper = null;
            workletPromise = null;

            // 3. Destroy the context reference IMMEDIATELY so the next boot works
            audioCtx = undefined; 

            // 4. Boot the engine back up from scratch!
            initAudio();

            // THE FIX: Explicitly wake the newly spawned engine while still inside the user's click event!
            if (audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
                try {
                    await audioCtx.resume();
                    console.log("Panic: Audio Engine forcefully awakened after reboot.");
                } catch (e) {
                    console.error("Panic: Failed to wake audio engine:", e);
                }
            }
            
            showToast("Panic: Audio Engine Rebooted & Notes Stopped");
        } else {
            showToast("Panic: All Notes Stopped");
        }

        updateHighlights();
    }

    if (isNativeApp && btnFs) {
        // Transform the button for Native Mobile Apps
        btnFs.id = 'btnPanic';
        btnFs.title = 'Panic / All Notes Off';
        btnFs.textContent = '🔇';
        btnFs.addEventListener('click', executePanic);
    } else if (btnFs) {
        // Keep standard Fullscreen logic for Web Browsers
        btnFs.addEventListener('click', () => {
            if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(err => console.warn(err));
            else if (document.exitFullscreen) document.exitFullscreen();
        });
        document.addEventListener('fullscreenchange', () => {
            const btn = document.getElementById('btnFullscreen');
            if (btn) {
                if (document.fullscreenElement) { btn.textContent = '🗗'; btn.classList.add('toggled'); }
                else { btn.textContent = '⛶'; btn.classList.remove('toggled'); }
            }
        });
    }

    window.addEventListener('resize', () => { updateOverlayCSSVars(); });

    // --- CUSTOM COLOR THEMES ---
    document.getElementById('themeColorSelect')?.addEventListener('change', e => {
        const theme = e.target.value;
        // 1. Strip out any existing theme classes
        document.body.classList.remove('theme-blue', 'theme-green', 'theme-orange', 'theme-pink');

        // 2. If it's not the default purple, append the new class!
        if (theme !== 'purple') {
            document.body.classList.add(`theme-${theme}`);
        }
    });

    document.getElementById('btnTheme')?.addEventListener('click', (e) => {
        isDarkMode = !isDarkMode; document.body.classList.toggle('dark-theme', isDarkMode);
        e.target.textContent = `Dark Mode: ${isDarkMode ? 'ON' : 'OFF'}`; e.target.classList.toggle('active-btn', isDarkMode);
    });

    document.getElementById('uiHideDelay')?.addEventListener('input', (e) => {
        uiHideDelay = parseInt(e.target.value); const lbl = document.getElementById('lblHideDelay');
        if (lbl) lbl.textContent = uiHideDelay === 0 ? 'Auto-Hide: OFF' : `Auto-Hide: ${uiHideDelay}ms`;
        if (uiHideDelay === 0) wakeNav();
    });

    document.getElementById('masterTune')?.addEventListener('input', (e) => {
        masterTune = parseInt(e.target.value); const lbl = document.getElementById('lblMasterTune');
        if (lbl) lbl.textContent = `Master Tune: ${masterTune} Hz`;
    });

    document.getElementById('bgEffectMode')?.addEventListener('change', e => { bgEffectMode = e.target.value; });

    document.getElementById('bgIntensity')?.addEventListener('input', e => {
        bgEffectIntensity = parseFloat(e.target.value);
        updateLabel('bgIntensity', Math.round(bgEffectIntensity * 100), 'BG Intensity', '%');
    });

    document.getElementById('cofSizeSlider')?.addEventListener('input', (e) => {
        const size = e.target.value; const cofOverlay = document.getElementById('cof-overlay');
        if (cofOverlay) { cofOverlay.style.width = `${size}vmin`; cofOverlay.style.height = `${size}vmin`; }
    });

    document.getElementById('btnExtensions')?.addEventListener('click', (e) => {
        showExtensions = !showExtensions; e.target.textContent = `7th/9th Ext. Highlights: ${showExtensions ? 'ON' : 'OFF'}`; e.target.classList.toggle('active-btn', showExtensions);
        if (!showExtensions) { document.querySelectorAll('.extension-highlight').forEach(el => el.classList.remove('extension-highlight')); }
        updateHighlights();
    });

    document.getElementById('btnChordDegrees')?.addEventListener('click', (e) => {
        showChordDegrees = !showChordDegrees;
        // Use the short text here!
        e.target.textContent = `Degrees: ${showChordDegrees ? 'ON' : 'OFF'}`;
        e.target.classList.toggle('active-btn', showChordDegrees);
        updatePianoVisuals();
    });

    // --- DUAL-SLIDER BPM SYNC ENGINE ---
    function syncBPM(newBpm) {
        currentArpBPM = parseInt(newBpm);

        // 1. Update the Main Settings Slider & Label
        const mainBpmSlider = document.getElementById('arpBpm');
        const mainBpmLbl = document.getElementById('lblArpBpm');
        if (mainBpmSlider && mainBpmSlider.value != currentArpBPM) mainBpmSlider.value = currentArpBPM;
        if (mainBpmLbl) mainBpmLbl.textContent = `Arp/Metron: ${currentArpBPM} BPM`;

        // 2. Update the Drum Panel Slider & Label
        const drumBpmSlider = document.getElementById('drumBpmSlider');
        const drumBpmLbl = document.getElementById('drumBpmValue');
        if (drumBpmSlider && drumBpmSlider.value != currentArpBPM) drumBpmSlider.value = currentArpBPM;
        if (drumBpmLbl) drumBpmLbl.textContent = currentArpBPM;

        // 3. Update active LFO timings if locked to BPM
        if (currentLfoSync === 'sync' && typeof updateLfoSpeed === 'function') updateLfoSpeed();

        // 4. Update the global BPM display if the master trransport header is visible
        if (globalBpmDisplay) globalBpmDisplay.textContent = `${currentArpBPM} BPM`;
    }

    // Attach listeners to BOTH sliders to trigger the sync function
    document.getElementById('arpBpm')?.addEventListener('input', (e) => syncBPM(e.target.value));
    document.getElementById('drumBpmSlider')?.addEventListener('input', (e) => syncBPM(e.target.value));

    // --- DAW FEATURE: Time-Stretching Engine ---
    let anchorBPM = 120; // Will be overwritten instantly on click
    
    ['arpBpm', 'drumBpmSlider'].forEach(id => {
        const slider = document.getElementById(id);
        if (!slider) return;

        // 1. Capture the exact BPM right before the user starts dragging
        slider.addEventListener('mousedown', () => { anchorBPM = currentArpBPM; });
        slider.addEventListener('touchstart', () => { anchorBPM = currentArpBPM; }, { passive: true });

        // 2. Perform the deep time-stretch ONLY when they let go of the mouse!
        slider.addEventListener('change', (e) => {
            const newBPM = parseInt(e.target.value) || 120;
            if (newBPM === anchorBPM) return;
            
            const ratio = anchorBPM / newBPM; // E.g. stretching 120 to 60 yields a 2.0x time multiplier
            
            // Helper to stretch all temporal data in an array of tracks
            const stretchTracks = (tracksArray) => {
                tracksArray.forEach(track => {
                    track.forEach(evt => {
                        if (evt.timeOffset !== undefined) evt.timeOffset *= ratio;
                        if (evt.start !== undefined) { evt.start *= ratio; evt.end *= ratio; }
                        if (evt.duration !== undefined) evt.duration *= ratio;
                    });
                });
            };

            // Stretch Looper
            stretchTracks(looper.tracks);
            if (looper.trackDurations) looper.trackDurations = looper.trackDurations.map(d => d * ratio);
            if (looper.regions) {
                looper.regions.forEach(regionArr => regionArr.forEach(r => { r.start *= ratio; r.end *= ratio; }));
            }
            
            // Stretch Arranger
            stretchTracks(arranger.tracks);
            if (arranger.duration !== undefined) arranger.duration *= ratio;

            // Reset anchor for the next time the user clicks the slider
            anchorBPM = newBPM; 
            
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
            // Optional: showToast(`Tempo stretched to ${newBPM} BPM`);
        });
    });

    // Global state for drum fill intensity (0.0 to 1.0)
    let currentDrumFills = 0.50;
    document.getElementById('drumFillsSlider')?.addEventListener('input', (e) => {
        currentDrumFills = parseInt(e.target.value) / 100;
        const lbl = document.getElementById('drumFillsValue');
        if (lbl) lbl.textContent = e.target.value;
    });

    document.getElementById('arpRhythm')?.addEventListener('change', e => currentArpRhythm = e.target.value);
    document.getElementById('arpSwing')?.addEventListener('input', (e) => {
        currentArpSwing = parseFloat(e.target.value); const lbl = document.getElementById('lblArpSwing');
        if (lbl) lbl.textContent = `Swing Effect: ${Math.round(currentArpSwing * 100)}%`;
    });
    document.getElementById('arpLoop')?.addEventListener('change', e => currentArpLoop = e.target.value === 'true');

    document.getElementById('drumHeightSlider')?.addEventListener('input', (e) => {
        document.querySelectorAll('.manual-drum-btn').forEach(btn => {
            btn.style.minHeight = `${e.target.value}px`;
            btn.style.height = `${e.target.value}px`;
        });
        updateOverlayCSSVars();
    });

    document.getElementById('padHeightSlider')?.addEventListener('input', (e) => {
        document.querySelectorAll('.big-tap-btn').forEach(btn => {
            btn.style.minHeight = `${e.target.value}px`;
            btn.style.height = `${e.target.value}px`;
        });
        updateOverlayCSSVars();
    });

    // --- DRUM PRESET & TIME SIGNATURE LOGIC ---
    let currentDrumPreset = 'none';

    // Toggle Time Signature
    document.getElementById('timeSignature')?.addEventListener('change', (e) => {
        beatsPerBar = parseInt(e.target.value);
        
        document.querySelectorAll('.drum-preset-btn').forEach(btn => {
            btn.style.display = parseInt(btn.dataset.meter) === beatsPerBar ? '' : 'none';
        });

        const activeBtn = document.querySelector(`.drum-preset-btn[data-preset="${currentDrumPreset}"]`);
        if (activeBtn && parseInt(activeBtn.dataset.meter) !== beatsPerBar) {
            updateDrumUI('none');
        }
        
        // THE FIX: Instantly redraw the grid lines to match the new meter!
        if (typeof drawPianoRoll === 'function') drawPianoRoll();
    });

    const updateDrumUI = (val) => {
        currentDrumPreset = val;
        document.querySelectorAll('.drum-preset-btn').forEach(btn => {
            btn.classList.toggle('active-btn', btn.dataset.preset === val);
        });
    };

    document.querySelectorAll('.drum-preset-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            initAudio(); // Ensure the audio engine wakes up
            const clickedPreset = e.target.dataset.preset;

            // If the user clicks the rhythm that is ALREADY playing, turn it OFF!
            if (currentDrumPreset === clickedPreset) {
                updateDrumUI('none');
                nextMetroTime = 0; 
            } else {
                updateDrumUI(clickedPreset);

                // --- THE ROUTING FIX ---
                // Officially claim the active track as a Drum Track so the live preset routes through its sliders!
                if (typeof syncActiveTrackInstrument === 'function') {
                    syncActiveTrackInstrument(true);
                }

                // --- THE DAW RECORDING FIX ---
                // If the user selects a drum rhythm while a track is armed, instantly begin recording!
                const now = audioCtx ? audioCtx.currentTime : 0;
                let stateChanged = false;
                
                if (looper.isArmed) { 
                    looper.isArmed = false; looper.isRecording = true; looper.isPlaying = true; 
                    looper.startTime = now; stateChanged = true; 
                }
                if (arranger.isArmed) { 
                    arranger.isArmed = false; arranger.isRecording = true; arranger.isPlaying = true; 
                    arranger.startTime = now; stateChanged = true; 
                }
                
                if (stateChanged) updateStudioUI();
            }
        });
    });

    function checkSustainRelease() { if (!isSustainOn()) releaseSustainedNotes(); }

    function updatePadVisuals() {
        const tSus = document.getElementById('tapSustain'); if (tSus) tSus.classList.toggle('held', sustainHeld || sustainLocked);
        const tDampen = document.getElementById('tapDampen'); if (tDampen) tDampen.classList.toggle('held', dampenHeld);
        const tGlide = document.getElementById('tapGlide'); if (tGlide) tGlide.classList.toggle('held', glideHeld || glideLocked);
        const tVoice = document.getElementById('tapVoiceLead'); if (tVoice) tVoice.classList.toggle('held', voiceLeadHeld);
        const tOctD = document.getElementById('tapOctDown'); if (tOctD) tOctD.classList.toggle('held', octDownHeld || (octLocked && octMode === 'down'));
        const tOctU = document.getElementById('tapOctUp'); if (tOctU) tOctU.classList.toggle('held', octUpHeld || (octLocked && octMode === 'up'));

        const tArpU = document.getElementById('tapArpUp'); if (tArpU) tArpU.classList.toggle('held', arpUpHeld || (arpLocked && arpMode === 'up'));
        const tArpD = document.getElementById('tapArpDown'); if (tArpD) tArpD.classList.toggle('held', arpDownHeld || (arpLocked && arpMode === 'down'));
        const tArpR = document.getElementById('tapArpRandom'); if (tArpR) tArpR.classList.toggle('held', arpRandomHeld || (arpLocked && arpMode === 'random'));

        const ids = [
            ['tap69', add69Held], ['tapMaj7', addMaj7Held], ['tapFlat5', addFlat5Held], ['tapSharp5', addSharp5Held], ['tapSus4', addSus4Held],
            ['tap6th', add6Held], ['tap7th', add7Held || add7Locked], ['tap9th', add9Held], ['tap11th', add11Held], ['tapSus2', addSus2Held],
            ['tap13th', add13Held], ['tapFlat9', addFlat9Held], ['tapSharp9', addSharp9Held], ['tapSharp11', addSharp11Held], ['tapFlat13', addFlat13Held]
        ];
        ids.forEach(([id, state]) => { const el = document.getElementById(id); if (el) el.classList.toggle('held', state); });
    }

    // ==========================================
    // 5. MOUSE & TOUCH INTERACTION ENGINE
    // ==========================================
    let isMouseDownGlobal = false;
    let activePointerMap = new Map();
    let elementTouchCount = new Map();
    let panningPointerId = null;

    function triggerElementStart(el, pointerId) {
        if (!el || !el._startAction) return;
        const currentEl = activePointerMap.get(pointerId);
        if (currentEl !== el) {
            if (currentEl) triggerElementStop(pointerId);
            activePointerMap.set(pointerId, el);

            let count = elementTouchCount.get(el) || 0;
            if (count === 0) {
                triggerHaptic();
                el._startAction();
            }
            elementTouchCount.set(el, count + 1);
        }
    }

    function triggerElementStop(pointerId) {
        const el = activePointerMap.get(pointerId);
        if (el) {
            let count = elementTouchCount.get(el) || 0;
            count = Math.max(0, count - 1);
            elementTouchCount.set(el, count);
            if (count === 0 && el._stopAction) el._stopAction();
            activePointerMap.delete(pointerId);
        }
    }

    function getInteractiveElement(clientX, clientY) {
        let el = document.elementFromPoint(clientX, clientY);
        if (el) {
            let interactiveEl = el.closest('.highlightable, .manual-drum-btn, .big-tap-btn, .piano-key');
            if (interactiveEl) return interactiveEl;
        }
        return null;
    }

    document.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        isMouseDownGlobal = true;
        if (e.target.closest('#tonnetz-wrapper') && e.target.tagName === 'svg') {
            t_isDragging = true; t_startX = e.clientX - t_panX; t_startY = e.clientY - t_panY; return;
        }
        // PERFORMANCE FIX: Grab direct target instead of elementFromPoint calculation
        let el = e.target.closest('.highlightable, .manual-drum-btn, .big-tap-btn, .piano-key');
        if (el) triggerElementStart(el, "mouse");
    });

    document.addEventListener('mousemove', e => {
        if (t_isDragging) {
            t_panX = e.clientX - t_startX; t_panY = e.clientY - t_startY;
            applyTransform();
            return;
        }

        if (isMacroDragging) return;

        if (!isMouseDownGlobal) return;
        let el = getInteractiveElement(e.clientX, e.clientY);
        if (el) {
            triggerElementStart(el, "mouse");
        } else {
            triggerElementStop("mouse");
        }
    });

    document.addEventListener('mouseup', () => {
        isMouseDownGlobal = false;
        t_isDragging = false;
        triggerElementStop("mouse");
    });

    window.addEventListener('blur', () => {
        isMouseDownGlobal = false;
        t_isDragging = false;
        triggerElementStop("mouse");
    });

    document.addEventListener('touchstart', e => {
        if (e.target.closest('svg') || e.target.closest('.piano-overlay') || e.target.closest('.manual-drum-grid') || e.target.closest('.pad-grid')) {
            if (e.cancelable) e.preventDefault();
        }
        for (let i = 0; i < e.changedTouches.length; i++) {
            let touch = e.changedTouches[i];

            // TOUCHSCREEN FIX: Register the coordinates immediately so micro-wobbles don't instantly cancel the touch
            lastTouchMap.set(touch.identifier, { x: touch.clientX, y: touch.clientY });

            if (e.touches.length === 1 && e.target.closest('#tonnetz-wrapper') && e.target.tagName === 'svg') {
                t_isDragging = true; t_startX = touch.clientX - t_panX; t_startY = touch.clientY - t_panY; panningPointerId = touch.identifier;
            } else {
                let el = touch.target.closest('.highlightable, .manual-drum-btn, .big-tap-btn, .piano-key');
                if (el) triggerElementStart(el, touch.identifier);
            }
        }
    }, { passive: false });

    const lastTouchMap = new Map();
    let isGlissando = false;
    let glissandoTimeout = null;

    document.addEventListener('touchmove', e => {
        if (e.target.closest('svg') || e.target.closest('.piano-overlay') || e.target.closest('.manual-drum-grid') || e.target.closest('.pad-grid')) {
            if (e.cancelable) e.preventDefault();
            wakeNav();
        }

        const now = Date.now();

        for (let i = 0; i < e.changedTouches.length; i++) {
            let touch = e.changedTouches[i];

            // 1. PANNING OVERRIDE
            if (touch.identifier === panningPointerId && t_isDragging) {
                t_panX = touch.clientX - t_startX;
                t_panY = touch.clientY - t_startY;
                applyTransform();
                continue;
            }

            // 2. HIT-TESTING SUSPENSION
            if (t_isDragging || isMacroDragging) continue;

            // 3. VELOCITY CALCULATION
            let lastTouch = lastTouchMap.get(touch.identifier);
            if (lastTouch) {
                const dx = touch.clientX - lastTouch.x;
                const dy = touch.clientY - lastTouch.y;
                const dt = now - lastTouch.time;

                if (dt > 0) {
                    const speed = Math.sqrt(dx * dx + dy * dy) / dt; // Pixels per millisecond

                    // If moving faster than ~1.5px/ms, trigger Glissando Mode
                    if (speed > 1.5) {
                        isGlissando = true;
                        clearTimeout(glissandoTimeout);

                        // Return to normal rendering 50ms after the finger slows down/stops
                        glissandoTimeout = setTimeout(() => {
                            isGlissando = false;
                            updateHighlights();
                        }, 50);
                    }
                }
            }

            // Update memory cache
            if (lastTouch) {
                lastTouch.time = now; lastTouch.x = touch.clientX; lastTouch.y = touch.clientY;
            } else {
                lastTouchMap.set(touch.identifier, { x: touch.clientX, y: touch.clientY, time: now });
            }

            // 4. UNTHROTTLED HIT TESTING: Guarantees perfect audio on fast swipes
            let el = getInteractiveElement(touch.clientX, touch.clientY);
            if (el) {
                triggerElementStart(el, touch.identifier);
            } else {
                triggerElementStop(touch.identifier);
            }
        }
    }, { passive: false });

    function endTouches(e) {
        for (let i = 0; i < e.changedTouches.length; i++) {
            let touch = e.changedTouches[i];
            lastTouchMap.delete(touch.identifier); // Clear throttle cache

            if (touch.identifier === panningPointerId) {
                t_isDragging = false;
                panningPointerId = null;
            } else {
                triggerElementStop(touch.identifier);
            }
        }
    }

    document.addEventListener('touchend', endTouches, { passive: false });
    document.addEventListener('touchcancel', endTouches, { passive: false });

    if (tonnetzWrapper) {
        tonnetzWrapper.addEventListener('wheel', (e) => {
            
            // --- Yield the mouse wheel to the Mod Wheel if notes are playing! ---
            if ((typeof activeUserNotes !== 'undefined' && activeUserNotes > 0) || 
                (typeof sustainedVoices !== 'undefined' && sustainedVoices.size > 0)) {
                return; // Abort Tonnetz zoom. Let the event bubble up to the global Mod Wheel listener!
            }
            
            e.preventDefault();
            wakeNav();

            const w = window.innerWidth;
            const h = window.innerHeight;
            const mx = e.clientX - w / 2;
            const my = e.clientY - h / 2;

            const svgX = (mx - t_panX) / t_scale;
            const svgY = (my - t_panY) / t_scale;

            // Request new scale
            const zoomAmount = e.deltaY > 0 ? 0.9 : 1.1;
            t_scale *= zoomAmount;

            // Let the constraint engine (inside applyTransform) enforce the min/max limits
            // but we proactively adjust pan towards the mouse cursor first
            t_panX = mx - svgX * t_scale;
            t_panY = my - svgY * t_scale;

            targetPanX = t_panX; targetPanY = t_panY; isAnimatingPan = false;
            applyTransform();
        }, { passive: false });
    }

    function animatePan() {
        if (!isAnimatingPan) return;
        const diffX = targetPanX - t_panX; const diffY = targetPanY - t_panY;

        if (Math.abs(diffX) < 0.5 && Math.abs(diffY) < 0.5) {
            t_panX = targetPanX; t_panY = targetPanY;
            isAnimatingPan = false; applyTransform(); return;
        }

        t_panX += diffX * 0.15; t_panY += diffY * 0.15;
        applyTransform(); requestAnimationFrame(animatePan);
    }

    const handleZoomBtn = (e, zoomIn) => {
        e.preventDefault(); e.stopPropagation(); wakeNav();
        const zoomAmount = zoomIn ? 1.2 : 0.8;
        t_scale = Math.max(0.2, Math.min(t_scale * zoomAmount, 8));
        targetPanX = t_panX; targetPanY = t_panY; isAnimatingPan = false; applyTransform();
    };

    const handlePanBtnDown = (e, dirX, dirY) => {
        e.preventDefault(); e.stopPropagation(); wakeNav();
        if (t_isDragging) return;
        targetPanX = t_panX; targetPanY = t_panY;
        const doPan = () => {
            targetPanX += dirX * DX * t_scale;
            targetPanY += dirY * DY * t_scale;
            if (!isAnimatingPan) { isAnimatingPan = true; animatePan(); }
        };
        doPan();
        if (panIntervalId) clearInterval(panIntervalId);
        panIntervalId = setInterval(doPan, 500);
    };

    const handlePanBtnUp = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        if (panIntervalId) clearInterval(panIntervalId);
        panIntervalId = null;
    };

    const attachPan = (id, dx, dy) => {
        const el = document.getElementById(id); if (!el) return;
        const down = e => handlePanBtnDown(e, dx, dy);
        el.addEventListener('mousedown', down);
        el.addEventListener('touchstart', down, { passive: false });
        ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => {
            el.addEventListener(evt, handlePanBtnUp);
        });
    };

    attachPan('btnPanUp', 0, 1);
    attachPan('btnPanDown', 0, -1);
    attachPan('btnPanLeft', 1, 0);
    attachPan('btnPanRight', -1, 0);

    document.getElementById('btnHome')?.addEventListener('click', () => centerOnRoot(true));

    const attachZoom = (id, isZoomIn) => {
        const el = document.getElementById(id); if (!el) return;
        const down = e => handleZoomBtn(e, isZoomIn);
        el.addEventListener('mousedown', down);
        el.addEventListener('touchstart', down, { passive: false });
    };
    attachZoom('btnZoomIn', true);
    attachZoom('btnZoomOut', false);

    function applyDampening(isDampened) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        const dampenTime = 0.05;

        const adjustNodeData = (nodeData) => {
            if (nodeData.type === 'arp') return;
            nodeData.voices.forEach(({ filter, gainNode, freq, isChord, accentMult }) => {
                try {
                    gainNode.gain.cancelScheduledValues(now);
                    filter.frequency.cancelScheduledValues(now);

                    if (isDampened) {
                        gainNode.gain.setTargetAtTime(0.02, now, dampenTime);
                        filter.frequency.setTargetAtTime(600, now, dampenTime);
                    } else {
                        const targetBaseCutoff = Math.min(freq * currentBrightness, 12000);
                        const peak = 0.12 * (accentMult || (isChord ? 1.4 : 0.8));
                        const sustainLevel = Math.max(0.001, peak * currentSustain);

                        gainNode.gain.setTargetAtTime(sustainLevel, now, dampenTime);
                        filter.frequency.setTargetAtTime(targetBaseCutoff, now, dampenTime);
                    }
                } catch (e) { }
            });
        };

        activeNodes.forEach(adjustNodeData);
        sustainedVoices.forEach(adjustNodeData);
    }

    // Connect the HTML Performance Pads to the modifier engine
    function setupTapPad(id, onPress, onRelease) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.add('highlightable');
        el._startAction = () => { wakeNav(); onPress(); updatePadVisuals(); retriggerHeldNodes(); };
        el._stopAction = () => { onRelease(); updatePadVisuals(); retriggerHeldNodes(); };
    }

    const sendMidiCC = (cc, val) => { if (midiOut) { for (let c = 0; c < 16; c++) midiOut.send([0xB0 + c, cc, val]); } };

    setupTapPad('tapSustain', () => { sustainHeld = true; sendMidiCC(64, 127); }, () => { sustainHeld = false; sendMidiCC(64, 0); checkSustainRelease(); });
    setupTapPad('tapDampen', () => { dampenHeld = true; applyDampening(true); }, () => { dampenHeld = false; applyDampening(false); });
    setupTapPad('tapGlide', () => { glideHeld = true; }, () => { glideHeld = false; });
    setupTapPad('tapVoiceLead', () => { voiceLeadHeld = true; }, () => { voiceLeadHeld = false; });
    setupTapPad('tapOctDown', () => { octDownHeld = true; octMode = 'down'; }, () => { octDownHeld = false; });
    setupTapPad('tapOctUp', () => { octUpHeld = true; octMode = 'up'; }, () => { octUpHeld = false; });

    setupTapPad('tapArpUp', () => { arpUpHeld = true; arpMode = 'up'; }, () => { arpUpHeld = false; });
    setupTapPad('tapArpDown', () => { arpDownHeld = true; arpMode = 'down'; }, () => { arpDownHeld = false; });
    setupTapPad('tapArpRandom', () => { arpRandomHeld = true; arpMode = 'random'; }, () => { arpRandomHeld = false; });

    setupTapPad('tap69', () => { add69Held = true; }, () => { add69Held = false; });
    setupTapPad('tapMaj7', () => { addMaj7Held = true; }, () => { addMaj7Held = false; });
    setupTapPad('tapFlat5', () => { addFlat5Held = true; }, () => { addFlat5Held = false; });
    setupTapPad('tapSharp5', () => { addSharp5Held = true; }, () => { addSharp5Held = false; });
    setupTapPad('tapSus4', () => { addSus4Held = true; }, () => { addSus4Held = false; });

    setupTapPad('tap6th', () => { add6Held = true; }, () => { add6Held = false; });
    setupTapPad('tap7th', () => { add7Held = true; }, () => { add7Held = false; });
    setupTapPad('tap9th', () => { add9Held = true; }, () => { add9Held = false; });
    setupTapPad('tap11th', () => { add11Held = true; }, () => { add11Held = false; });
    setupTapPad('tapSus2', () => { addSus2Held = true; }, () => { addSus2Held = false; });

    setupTapPad('tap13th', () => { add13Held = true; }, () => { add13Held = false; });
    setupTapPad('tapFlat9', () => { addFlat9Held = true; }, () => { addFlat9Held = false; });
    setupTapPad('tapSharp9', () => { addSharp9Held = true; }, () => { addSharp9Held = false; });
    setupTapPad('tapSharp11', () => { addSharp11Held = true; }, () => { addSharp11Held = false; });
    setupTapPad('tapFlat13', () => { addFlat13Held = true; }, () => { addFlat13Held = false; });

    document.getElementById('lockSustain')?.addEventListener('click', function () { sustainLocked = !sustainLocked; this.classList.toggle('active-btn', sustainLocked); checkSustainRelease(); updatePadVisuals(); });
    document.getElementById('lockGlide')?.addEventListener('click', function () { glideLocked = !glideLocked; this.classList.toggle('active-btn', glideLocked); updatePadVisuals(); });
    document.getElementById('glideMode')?.addEventListener('change', e => currentGlideMode = e.target.value);
    document.getElementById('lock7th')?.addEventListener('click', function () { add7Locked = !add7Locked; this.classList.toggle('active-btn', add7Locked); updatePadVisuals(); retriggerHeldNodes(); });
    document.getElementById('lockOct')?.addEventListener('click', function () { octLocked = !octLocked; this.classList.toggle('active-btn', octLocked); if (octLocked && !octUpHeld && !octDownHeld) octMode = 'up'; updatePadVisuals(); retriggerHeldNodes(); });
    document.getElementById('lockArp')?.addEventListener('click', function () { arpLocked = !arpLocked; this.classList.toggle('active-btn', arpLocked); if (arpLocked && !arpUpHeld && !arpDownHeld && !arpRandomHeld) arpMode = 'up'; updatePadVisuals(); retriggerHeldNodes(); });

    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            const key = e.key ? e.key.toLowerCase() : '';
            if (['1', '2', '3', '4', '5', 'q', 'w', 'e', 'r', 't', 'a', 's', 'd', 'f', 'g', 'z', 'y', 'x', 'c', 'v', 'b'].includes(key) ||
                ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyZ', 'KeyY', 'KeyX', 'KeyC', 'KeyV', 'KeyB'].includes(e.code)) {
                e.preventDefault();
            }
        }
    }, { capture: true });

    document.addEventListener('keydown', (e) => {
        // --- TAB KEY REPEAT FIX ---
        // We must prevent default on Tab immediately, even for repeating keys, 
        // so the browser never steals focus away from the app!
        if (e.code === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
        }

        if (e.repeat || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
        let trigger = false; wakeNav();

        switch (e.code) {
            // Row 1 (Numbers)
            case 'Digit1': octDownHeld = true; octMode = 'down'; trigger = true; break;
            case 'Digit2': octUpHeld = true; octMode = 'up'; trigger = true; break;
            case 'Digit3': arpUpHeld = true; arpMode = 'up'; trigger = true; break;
            case 'Digit4': arpDownHeld = true; arpMode = 'down'; trigger = true; break;
            case 'Digit5': arpRandomHeld = true; arpMode = 'random'; trigger = true; break;

            // Row 2 (QWERTY)
            case 'KeyQ': add69Held = true; trigger = true; break;
            case 'KeyW': addMaj7Held = true; trigger = true; break;
            case 'KeyE': addFlat5Held = true; trigger = true; break;
            case 'KeyR': addSharp5Held = true; trigger = true; break;
            case 'KeyT': addSus4Held = true; trigger = true; break;

            // Row 3 (ASDFG)
            case 'KeyA': add6Held = true; trigger = true; break;
            case 'KeyS': add7Held = true; trigger = true; break;
            case 'KeyD': add9Held = true; trigger = true; break;
            case 'KeyF': add11Held = true; trigger = true; break;
            case 'KeyG': add13Held = true; trigger = true; break;

            // Row 4 (ZXCVB)
            case 'KeyZ': case 'KeyY': addSus2Held = true; trigger = true; break;
            case 'KeyX': addFlat9Held = true; trigger = true; break;
            case 'KeyC': addSharp9Held = true; trigger = true; break;
            case 'KeyV': addSharp11Held = true; trigger = true; break;
            case 'KeyB': addFlat13Held = true; trigger = true; break;

            // Other Modifiers
            case 'Tab': if (document.activeElement) document.activeElement.blur(); glideHeld = true; trigger = true; break;
            case 'AltLeft': dampenHeld = true; applyDampening(true); trigger = true; break;
            case 'Space': if (!sustainHeld) { sustainHeld = true; sendMidiCC(64, 127); trigger = true; } break;
            case 'ShiftLeft': case 'ShiftRight': voiceLeadHeld = true; trigger = true; break;
        }
        if (trigger) { e.preventDefault(); updatePadVisuals(); retriggerHeldNodes(); }
    }, { capture: true });


    document.addEventListener('keyup', (e) => {
        if (e.target.tagName === 'INPUT') return;
        let trigger = false;

        switch (e.code) {
            case 'Digit1': octDownHeld = false; trigger = true; break;
            case 'Digit2': octUpHeld = false; trigger = true; break;
            case 'Digit3': arpUpHeld = false; trigger = true; break;
            case 'Digit4': arpDownHeld = false; trigger = true; break;
            case 'Digit5': arpRandomHeld = false; trigger = true; break;

            case 'KeyQ': add69Held = false; trigger = true; break;
            case 'KeyW': addMaj7Held = false; trigger = true; break;
            case 'KeyE': addFlat5Held = false; trigger = true; break;
            case 'KeyR': addSharp5Held = false; trigger = true; break;
            case 'KeyT': addSus4Held = false; trigger = true; break;

            case 'KeyA': add6Held = false; trigger = true; break;
            case 'KeyS': add7Held = false; trigger = true; break;
            case 'KeyD': add9Held = false; trigger = true; break;
            case 'KeyF': add11Held = false; trigger = true; break;
            case 'KeyG': add13Held = false; trigger = true; break;

            case 'KeyZ': case 'KeyY': addSus2Held = false; trigger = true; break;
            case 'KeyX': addFlat9Held = false; trigger = true; break;
            case 'KeyC': addSharp9Held = false; trigger = true; break;
            case 'KeyV': addSharp11Held = false; trigger = true; break;
            case 'KeyB': addFlat13Held = false; trigger = true; break;

            case 'Tab':
                e.preventDefault();
                e.stopPropagation();
                glideHeld = false;
                trigger = true;
                break;

            case 'AltLeft': dampenHeld = false; applyDampening(false); trigger = true; break;
            case 'Space': sustainHeld = false; sendMidiCC(64, 0); trigger = true; checkSustainRelease(); break;
            case 'ShiftLeft': case 'ShiftRight': voiceLeadHeld = false; trigger = true; break;
        }
        if (trigger) { e.preventDefault(); updatePadVisuals(); retriggerHeldNodes(); }
    }, { capture: true });


    // ==========================================
    // 2. AUDIO ENGINE & SYNTHESIZER
    // ==========================================

    const activeNodes = new Map();
    const sustainedVoices = new Set();
    const pianoExtensionNotes = new Set();

    // --- GLOBAL AUDIO VARIABLES ---
    let audioCtx;
    let masterGain, compressor, delayNode, feedbackGain, delayMix;
    let preDistortionGain, distortionNode;
    let globalLfoBase, globalLfoOutput, globalLfoPolarityGain, globalLfoPolarityOffset, sahShaper, lfoPanGain;
    let convolver, reverbGain;
    let sharedNoiseBuffer = null;
    let masterSynthPanner;
    let currentAutoPan = 0;
    let safetyClipper = null;
    let analyzer;
    let synthGain, drumGain, looperMasterGain, eqLow, eqMid, eqHigh, masterEqIn, importedAudioMasterGainNode;
    let linearMasterGain;
    let looperGainNodes = [], looperPanners = [], looperEchoSends = [], looperReverbSends = [];
    let linearGainNodes = [], linearPanners = [], linearEchoSends = [], linearReverbSends = [];

    // Pre-allocate memory once to prevent Garbage Collection stutter
    const SAFETY_CURVE_SIZE = 44100;
    const safetyCurveBuffer = new Float32Array(SAFETY_CURVE_SIZE);

    function updateSafetyCurve(type) {
        if (!safetyClipper) return;

        if (type === 'none') {
            safetyClipper.curve = null;
            return;
        }

        for (let i = 0; i < SAFETY_CURVE_SIZE; i++) {
            const x = (i * 2) / SAFETY_CURVE_SIZE - 1;
            if (type === 'brickwall') {
                // Transparent 1:1 until the absolute ceiling
                safetyCurveBuffer[i] = Math.max(-0.98, Math.min(0.98, x));
            } else if (type === 'soft') {
                // Warm, analog-style saturation
                safetyCurveBuffer[i] = Math.tanh(x) * 0.95;
            }
        }

        // Re-assigning the buffer forces the Web Audio API to apply the changes
        safetyClipper.curve = safetyCurveBuffer;
    }

    let currentTranspose = 0;
    let currentReverb = 0;
    let currentOsc1 = 'triangle', currentOsc2 = 'sine', currentDetune = 2, currentOsc2Mult = 1;
    let currentSubOsc = 0.05, currentNoise = 0.03, currentOscMix = 0.5, currentGlide = 0, currentFilterType = 'lowpass';
    let currentSampleRootKey = 60;
    let currentOvertones = 0;
    const acousticWaveCache = new Map();
    const numHarmonics = 8;
    const overtoneReal = new Float32Array(numHarmonics);
    const overtoneImag = new Float32Array(numHarmonics);
    let currentAttack = 0.01, currentDecay = 0.4, currentSustain = 0.2, currentRelease = 0.3;
    let currentDistortion = 0, currentBrightness = 2.2, currentResonance = 1, currentFilterEnv = 3;
    let currentLfoSpeed = 5.5, currentVibrato = 0, currentSweep = 0, currentTremolo = 0;
    let currentLfoShape = 'sine', currentLfoSync = 'free', lfoRetrigger = false;
    let currentLfoDelay = 0, currentLfoFade = 0, currentLfoKeytrack = 0, currentLfoPolarity = 'bipolar';
    let currentChorus = 2, currentEcho = 0.05, currentReverbMix = 0.25;
    let currentVelocity = 100, lastPlayedFreq = null;
    let midiOutMode = 'both';

    // --- HARDWARE SAMPLER MEMORY ---
    let isSamplerMode = false;
    let isSamplerLooping = true;
    const sampleBank = new Map();
    
    // --- NEW: GAIN STAGING MEMORY ---
    const sampleGainCompensation = new Map();
    const TARGET_RMS = 0.1; 

    function getBufferRMS(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0); 
        let sumSquares = 0;
        const step = 10; // Sample every 10th frame to save CPU
        let count = 0;
        
        for (let i = 0; i < channelData.length; i += step) {
            sumSquares += channelData[i] * channelData[i];
            count++;
        }
        return Math.sqrt(sumSquares / count);
    }

    // This single helper performs the math and safely stores the buffer in RAM
    function registerSample(instName, audioBuffer) {
        if (!audioBuffer) return;
        
        const actualRms = getBufferRMS(audioBuffer);
        let compensationMultiplier = 1.0;
        
        if (actualRms > 0.001) { 
            compensationMultiplier = TARGET_RMS / actualRms;
        }
        // Cap the boost at 4.0x (+12dB) so background hiss isn't deafening
        compensationMultiplier = Math.min(compensationMultiplier, 4.0); 

        sampleGainCompensation.set(instName, compensationMultiplier);
        sampleBank.set(instName, audioBuffer);
    }

    document.getElementById('btnMidiOutput')?.addEventListener('click', e => {
        midiOutMode = midiOutMode === 'both' ? 'midi' : 'both';
        e.target.textContent = midiOutMode === 'both' ? 'MIDI OUT: MIDI + BROWSER' : 'MIDI OUT: MIDI ONLY';
        e.target.classList.toggle('active-btn', midiOutMode === 'midi');
    });

    const presets = {
        // --- KEYS & ORGANS ---
        piano: { attack: 0.01, decay: 0.4, sustain: 0.1, release: 0.5, distortion: 0, brightness: 0.2, resonance: 1.0, chorus: 2, echo: 0.02, reverbMix: 0.4, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 1, filterEnv: 7.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 8, subOsc: 0, noise: 0.05, overtones: 0.2, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        epiano: { attack: 0.01, decay: 0.4, sustain: 0.4, release: 0.5, distortion: 1, brightness: 1.0, resonance: 2.0, chorus: 15, echo: 0.1, reverbMix: 0.2, osc1: 'triangle', osc2: 'sine', osc2Mult: 2, filterEnv: 4.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.5, vibrato: 0, sweep: 0, tremolo: 0.3, detune: 8, subOsc: 0.1, noise: 0, overtones: 0.4, oscMix: 0.7, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0.5, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 12, sampleStart: 0, modWheel: 0 },
        lofi_keys: { attack: 0.02, decay: 0.4, sustain: 0.6, release: 0.6, distortion: 1, brightness: 0.5, resonance: 1.0, chorus: 10, echo: 0.15, reverbMix: 0.3, osc1: 'triangle', osc2: 'sine', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0.4, vibrato: 10, sweep: 0, tremolo: 0.05, detune: 12, subOsc: 0.2, noise: 0.15, overtones: 0, oscMix: 0.8, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        organ: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.1, distortion: 4, brightness: 6, resonance: 1.2, chorus: 20, echo: 0, reverbMix: 0.3, osc1: 'sine', osc2: 'triangle', osc2Mult: 3, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 6.8, vibrato: 8, sweep: 0, tremolo: 0.25, detune: 14, subOsc: 0.8, noise: 0.02, overtones: 0.2, oscMix: 0.5, filterType: 'lowpass', glide: 0, lfoDelay: 0.2, lfoFade: 0.2, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        church_organ: { attack: 0.05, decay: 0.2, sustain: 0.9, release: 0.8, distortion: 0, brightness: 8, resonance: 1, chorus: 10, echo: 0.1, reverbMix: 0.8, osc1: 'sawtooth', osc2: 'square', osc2Mult: 2, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 6, subOsc: 1.0, noise: 0.05, overtones: 0.8, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        reed_organ: { attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.3, distortion: 2, brightness: 3, resonance: 5, chorus: 5, echo: 0, reverbMix: 0.2, osc1: 'square', osc2: 'triangle', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4, vibrato: 5, sweep: 0, tremolo: 0.1, detune: 5, subOsc: 0.2, noise: 0.1, overtones: 0.2, oscMix: 0.7, filterType: 'lowpass', glide: 0, lfoDelay: 0.3, lfoFade: 0.4, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        accordion: { attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.2, distortion: 2, brightness: 2.5, resonance: 1.2, chorus: 15, echo: 0, reverbMix: 0.2, osc1: 'square', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4, vibrato: 5, sweep: 0, tremolo: 0.1, detune: 10, subOsc: 0, noise: 0.02, overtones: 0.15, oscMix: 0.5, filterType: 'lowpass', glide: 0, lfoDelay: 0.2, lfoFade: 0.3, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        harpsichord: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.15, distortion: 0, brightness: 1.5, resonance: 1.5, chorus: 0, echo: 0, reverbMix: 0.15, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 5.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 3, subOsc: 0, noise: 0.05, overtones: 0.3, oscMix: 0.7, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 12, sampleStart: 0, modWheel: 0 },

        // --- STRINGS & PLUCKS ---
        nylon_guitar: { attack: 0.01, decay: 0.3, sustain: 0.05, release: 0.7, distortion: 0, brightness: 0.5, resonance: 1.5, chorus: 2, echo: 0.1, reverbMix: 0.25, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 1, filterEnv: 3.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.0, vibrato: 5, sweep: 0, tremolo: 0, detune: 3, subOsc: 0.1, noise: 0.02, overtones: 0.2, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0.4, lfoFade: 0.3, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        western_guitar: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.9, distortion: 0, brightness: 1.2, resonance: 3.5, chorus: 8, echo: 0.1, reverbMix: 0.25, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 4.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 6, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.05, overtones: 0.25, oscMix: 0.8, filterType: 'lowpass', glide: 0, lfoDelay: 0.5, lfoFade: 0.4, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 12, sampleStart: 0, modWheel: 0 },
        steel_guitar: { attack: 0.01, decay: 0.8, sustain: 0.1, release: 1.0, distortion: 1, brightness: 3.5, resonance: 3.0, chorus: 8, echo: 0.15, reverbMix: 0.2, osc1: 'sawtooth', osc2: 'square', osc2Mult: 0.5, filterEnv: 1.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 8, sweep: 0, tremolo: 0, detune: 6, subOsc: 0, noise: 0.1, overtones: 0.3, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0.6, lfoFade: 0.5, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        bass: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.2, distortion: 6, brightness: 1.5, resonance: 4, chorus: 2, echo: 0.0, reverbMix: 0.05, osc1: 'sawtooth', osc2: 'square', osc2Mult: 0.5, filterEnv: 3, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 0, sweep: 0, tremolo: 0, detune: 6, subOsc: 1.0, noise: 0, overtones: 0.15, oscMix: 0.6, filterType: 'lowpass', glide: 0.02, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        slapbass: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.2, distortion: 8, brightness: 4.5, resonance: 6.0, chorus: 4, echo: 0, reverbMix: 0.1, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 6.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 4, subOsc: 0.8, noise: 0.15, overtones: 0.25, oscMix: 0.7, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        fretless: { attack: 0.05, decay: 0.4, sustain: 0.5, release: 0.4, distortion: 2, brightness: 1.8, resonance: 3.5, chorus: 15, echo: 0, reverbMix: 0.15, osc1: 'triangle', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 2.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.5, vibrato: 12, sweep: 0, tremolo: 0, detune: 5, subOsc: 0.8, noise: 0.02, overtones: 0.1, oscMix: 0.7, filterType: 'lowpass', glide: 0.15, lfoDelay: 0.4, lfoFade: 0.6, lfoKeytrack: 15, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        harp: { attack: 0.01, decay: 0.4, sustain: 0.05, release: 2.2, distortion: 0, brightness: 0.8, resonance: 1.5, chorus: 5, echo: 0.15, reverbMix: 0.45, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 1, filterEnv: 4.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.02, overtones: 0.2, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        shamisen: { attack: 0.01, decay: 0.2, sustain: 0.05, release: 0.3, distortion: 4, brightness: 3.5, resonance: 4, chorus: 2, echo: 0.1, reverbMix: 0.2, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 5.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 8, subOsc: 0, noise: 0.1, overtones: 0.3, oscMix: 0.6, filterType: 'lowpass', glide: 0.02, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        banjo: { attack: 0.01, decay: 0.15, sustain: 0.0, release: 0.2, distortion: 2, brightness: 4.0, resonance: 2.0, chorus: 0, echo: 0.05, reverbMix: 0.1, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 3.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 4, subOsc: 0, noise: 0.1, overtones: 0.35, oscMix: 0.6, filterType: 'highpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        sitar: { attack: 0.02, decay: 0.6, sustain: 0.1, release: 1.2, distortion: 4, brightness: 4.5, resonance: 6.0, chorus: 12, echo: 0.2, reverbMix: 0.35, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 2.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 15, sweep: 0, tremolo: 0, detune: 12, subOsc: 0.1, noise: 0.05, overtones: 0.6, oscMix: 0.5, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.8, lfoFade: 1.0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        violin: { attack: 0.25, decay: 0.4, sustain: 0.9, release: 0.6, distortion: 1, brightness: 2.5, resonance: 2.0, chorus: 12, echo: 0.2, reverbMix: 0.5, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 0.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 6.2, vibrato: 28, sweep: 0, tremolo: 0, detune: 12, subOsc: 0, noise: 0.1, overtones: 0.3, oscMix: 0.5, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.4, lfoFade: 0.5, lfoKeytrack: 15, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        cello: { attack: 0.2, decay: 0.3, sustain: 0.8, release: 0.6, distortion: 2, brightness: 1.6, resonance: 2.5, chorus: 8, echo: 0.15, reverbMix: 0.4, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 0.5, filterEnv: 1.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 20, sweep: 0, tremolo: 0, detune: 6, subOsc: 0.4, noise: 0.1, overtones: 0.35, oscMix: 0.7, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.6, lfoFade: 0.6, lfoKeytrack: 10, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        pizzicato: { attack: 0.01, decay: 0.15, sustain: 0.0, release: 0.15, distortion: 0, brightness: 1.0, resonance: 2.0, chorus: 4, echo: 0.05, reverbMix: 0.3, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 1, filterEnv: 6.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.05, overtones: 0.15, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },

        // --- BRASS & WINDS ---
        sax: { attack: 0.08, decay: 0.2, sustain: 0.8, release: 0.3, distortion: 6, brightness: 2.8, resonance: 3.5, chorus: 6, echo: 0.15, reverbMix: 0.4, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 1.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.2, vibrato: 18, sweep: 0, tremolo: 0, detune: 6, subOsc: 0.15, noise: 0.06, overtones: 0.35, oscMix: 0.65, filterType: 'lowpass', glide: 0.06, lfoDelay: 0.35, lfoFade: 0.4, lfoKeytrack: 12, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        trumpet: { attack: 0.05, decay: 0.15, sustain: 0.8, release: 0.2, distortion: 4, brightness: 4.0, resonance: 4.0, chorus: 4, echo: 0.1, reverbMix: 0.3, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 3.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.8, vibrato: 15, sweep: 0, tremolo: 0, detune: 4, subOsc: 0, noise: 0.08, overtones: 0.4, oscMix: 0.55, filterType: 'lowpass', glide: 0.04, lfoDelay: 0.2, lfoFade: 0.3, lfoKeytrack: 5, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        frenchhorn: { attack: 0.15, decay: 0.2, sustain: 0.8, release: 0.4, distortion: 1, brightness: 1.4, resonance: 2.0, chorus: 10, echo: 0.1, reverbMix: 0.45, osc1: 'sawtooth', osc2: 'triangle', osc2Mult: 1, filterEnv: 1.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.5, vibrato: 10, sweep: 0, tremolo: 0, detune: 8, subOsc: 0.2, noise: 0.02, overtones: 0.2, oscMix: 0.4, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.5, lfoFade: 0.6, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        tuba: { attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.3, distortion: 3, brightness: 1.1, resonance: 1.5, chorus: 2, echo: 0.05, reverbMix: 0.25, osc1: 'triangle', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 1.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.0, vibrato: 6, sweep: 0, tremolo: 0, detune: 3, subOsc: 1.0, noise: 0.05, overtones: 0.3, oscMix: 0.8, filterType: 'lowpass', glide: 0.05, lfoDelay: 0.6, lfoFade: 0.5, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        flute: { attack: 0.12, decay: 0.2, sustain: 0.8, release: 0.35, distortion: 0, brightness: 1.5, resonance: 1.5, chorus: 5, echo: 0.2, reverbMix: 0.4, osc1: 'triangle', osc2: 'sine', osc2Mult: 2, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 20, sweep: 0, tremolo: 0, detune: 4, subOsc: 0, noise: 0.15, overtones: 0.15, oscMix: 0.6, filterType: 'lowpass', glide: 0.06, lfoDelay: 0.25, lfoFade: 0.4, lfoKeytrack: 20, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        pan_flute: { attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.4, distortion: 0, brightness: 1.2, resonance: 2.0, chorus: 8, echo: 0.25, reverbMix: 0.5, osc1: 'triangle', osc2: 'sine', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 6.0, vibrato: 25, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.25, overtones: 0.2, oscMix: 0.5, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.3, lfoFade: 0.5, lfoKeytrack: 15, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        ocarina: { attack: 0.08, decay: 0.1, sustain: 0.9, release: 0.2, distortion: 0, brightness: 1.0, resonance: 1.0, chorus: 2, echo: 0.15, reverbMix: 0.35, osc1: 'sine', osc2: 'triangle', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 6.5, vibrato: 28, sweep: 0, tremolo: 0, detune: 2, subOsc: 0, noise: 0.05, overtones: 0.05, oscMix: 0.8, filterType: 'lowpass', glide: 0.12, lfoDelay: 0.1, lfoFade: 0.3, lfoKeytrack: 25, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        clarinet: { attack: 0.05, decay: 0.1, sustain: 0.9, release: 0.2, distortion: 0, brightness: 1.5, resonance: 1.5, chorus: 4, echo: 0.1, reverbMix: 0.25, osc1: 'square', osc2: 'triangle', osc2Mult: 1, filterEnv: 0.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.0, vibrato: 12, sweep: 0, tremolo: 0, detune: 3, subOsc: 0, noise: 0.05, overtones: 0.2, oscMix: 0.7, filterType: 'lowpass', glide: 0.04, lfoDelay: 0.3, lfoFade: 0.4, lfoKeytrack: 5, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        oboe: { attack: 0.04, decay: 0.1, sustain: 0.8, release: 0.2, distortion: 1, brightness: 3.5, resonance: 2.0, chorus: 5, echo: 0.15, reverbMix: 0.3, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.8, vibrato: 18, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.03, overtones: 0.35, oscMix: 0.6, filterType: 'bandpass', glide: 0.04, lfoDelay: 0.3, lfoFade: 0.4, lfoKeytrack: 8, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },

        // --- SYNTHS & PADS ---
        pad: { attack: 0.6, decay: 1.0, sustain: 0.8, release: 1.8, distortion: 0, brightness: 2.0, resonance: 3, chorus: 30, echo: 0.3, reverbMix: 0.65, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 1.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0.4, vibrato: 6, sweep: 1200, tremolo: 0, detune: 24, subOsc: 0.5, noise: 0.05, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.05, lfoDelay: 0, lfoFade: 1.0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: -12, sampleStart: 0, modWheel: 0 },
        glasspad: { attack: 0.8, decay: 0.5, sustain: 0.8, release: 2.0, distortion: 0, brightness: 4.5, resonance: 4.0, chorus: 25, echo: 0.4, reverbMix: 0.8, osc1: 'sine', osc2: 'triangle', osc2Mult: 2, filterEnv: 0.5, lfoShape: 'sah', lfoSync: 'free', lfoSpeed: 1.2, vibrato: 8, sweep: 800, tremolo: 0.2, detune: 15, subOsc: 0.2, noise: 0.02, overtones: 0.2, oscMix: 0.6, filterType: 'bandpass', glide: 0.1, lfoDelay: 0.5, lfoFade: 2.0, lfoKeytrack: 0, lfoPolarity: 'unipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        mellotron: { attack: 0.2, decay: 0.4, sustain: 0.8, release: 0.6, distortion: 6, brightness: 1.5, resonance: 2.0, chorus: 20, echo: 0.2, reverbMix: 0.5, osc1: 'triangle', osc2: 'sine', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.0, vibrato: 25, sweep: 0, tremolo: 0.1, detune: 18, subOsc: 0, noise: 0.3, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.05, lfoDelay: 0, lfoFade: 0.8, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        synth_strings: { attack: 0.4, decay: 0.5, sustain: 0.9, release: 1.2, distortion: 2, brightness: 3.5, resonance: 2.0, chorus: 30, echo: 0.2, reverbMix: 0.6, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 0.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0.5, vibrato: 10, sweep: 400, tremolo: 0, detune: 22, subOsc: 0.2, noise: 0.05, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.05, lfoDelay: 0, lfoFade: 1.0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        acid303: { attack: 0.01, decay: 0.25, sustain: 0.05, release: 0.1, distortion: 25, brightness: 1.0, resonance: 18.0, chorus: 0, echo: 0.15, reverbMix: 0.1, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 8.5, lfoShape: 'sawtooth', lfoSync: 'sync', lfoSpeed: 2, vibrato: 0, sweep: 1800, tremolo: 0, detune: 2, subOsc: 0.2, noise: 0, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.12, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'unipolar', osc2Pitch: -12, sampleStart: 0, modWheel: 0 },
        synthlead: { attack: 0.05, decay: 0.3, sustain: 0.8, release: 0.5, distortion: 8, brightness: 4.5, resonance: 8, chorus: 15, echo: 0.3, reverbMix: 0.35, osc1: 'sawtooth', osc2: 'square', osc2Mult: 1, filterEnv: 3, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.5, vibrato: 16, sweep: 1500, tremolo: 0, detune: 14, subOsc: 0.5, noise: 0, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.08, lfoDelay: 0.4, lfoFade: 0.2, lfoKeytrack: 5, lfoPolarity: 'unipolar', osc2Pitch: 7, sampleStart: 0, modWheel: 0 },
        chiptune: { attack: 0.01, decay: 0.1, sustain: 1.0, release: 0.05, distortion: 0, brightness: 8.0, resonance: 0, chorus: 0, echo: 0, reverbMix: 0, osc1: 'square', osc2: 'square', osc2Mult: 0.5, filterEnv: 0, lfoShape: 'square', lfoSync: 'sync', lfoSpeed: 8, vibrato: 100, sweep: 0, tremolo: 0, detune: 0, subOsc: 0, noise: 0, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0, lfoDelay: 0.2, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        synthbrass: { attack: 0.18, decay: 0.4, sustain: 0.7, release: 0.5, distortion: 0, brightness: 3.5, resonance: 2.5, chorus: 18, echo: 0.1, reverbMix: 0.4, osc1: 'sawtooth', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 6, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.0, vibrato: 8, sweep: 0, tremolo: 0, detune: 15, subOsc: 0.3, noise: 0, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.04, lfoDelay: 0.4, lfoFade: 0.3, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: -12, sampleStart: 0, modWheel: 0 },
        synth_flute: { attack: 0.05, decay: 0.2, sustain: 0.9, release: 0.3, distortion: 0, brightness: 1.5, resonance: 2.0, chorus: 10, echo: 0.3, reverbMix: 0.4, osc1: 'triangle', osc2: 'sine', osc2Mult: 2, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 15, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0.05, overtones: 0, oscMix: 0.6, filterType: 'lowpass', glide: 0.05, lfoDelay: 0.2, lfoFade: 0.3, lfoKeytrack: 10, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        choir: { attack: 0.6, decay: 0.5, sustain: 0.8, release: 1.2, distortion: 0, brightness: 1.8, resonance: 1.5, chorus: 22, echo: 0.2, reverbMix: 0.7, osc1: 'sine', osc2: 'sawtooth', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 4.2, vibrato: 12, sweep: 0, tremolo: 0, detune: 18, subOsc: 0.4, noise: 0.25, overtones: 0.1, oscMix: 0.4, filterType: 'lowpass', glide: 0.1, lfoDelay: 0.6, lfoFade: 0.8, lfoKeytrack: 5, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        theremin: { attack: 0.25, decay: 0.1, sustain: 1.0, release: 0.5, distortion: 0, brightness: 1.2, resonance: 1, chorus: 5, echo: 0.25, reverbMix: 0.6, osc1: 'sine', osc2: 'sine', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 6.5, vibrato: 45, sweep: 0, tremolo: 0, detune: 2, subOsc: 0.1, noise: 0, overtones: 0, oscMix: 0.5, filterType: 'lowpass', glide: 0.25, lfoDelay: 0.1, lfoFade: 0.4, lfoKeytrack: 25, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },

        // --- PERCUSSION & MALLETS ---
        musicbox: { attack: 0.01, decay: 0.4, sustain: 0, release: 0.8, distortion: 0, brightness: 6.0, resonance: 2.0, chorus: 5, echo: 0.25, reverbMix: 0.45, osc1: 'sine', osc2: 'triangle', osc2Mult: 2, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 5, subOsc: 0, noise: 0, overtones: 0.5, oscMix: 0.5, filterType: 'bandpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        glockenspiel: { attack: 0.01, decay: 0.8, sustain: 0, release: 1.2, distortion: 0, brightness: 8.0, resonance: 2.0, chorus: 5, echo: 0.15, reverbMix: 0.4, osc1: 'sine', osc2: 'sine', osc2Mult: 3, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 3, subOsc: 0, noise: 0, overtones: 0.8, oscMix: 0.5, filterType: 'highpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        kalimba: { attack: 0.01, decay: 0.2, sustain: 0.05, release: 0.4, distortion: 1, brightness: 2.5, resonance: 4.0, chorus: 2, echo: 0.1, reverbMix: 0.2, osc1: 'triangle', osc2: 'sine', osc2Mult: 1, filterEnv: 4.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 6, subOsc: 0.2, noise: 0.05, overtones: 0.2, oscMix: 0.6, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        marimba: { attack: 0.01, decay: 0.15, sustain: 0.0, release: 0.25, distortion: 0, brightness: 2.5, resonance: 4, chorus: 0, echo: 0.15, reverbMix: 0.15, osc1: 'sine', osc2: 'triangle', osc2Mult: 2, filterEnv: 2.5, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.5, vibrato: 0, sweep: 0, tremolo: 0, detune: 0, subOsc: 0.2, noise: 0.12, overtones: 0.6, oscMix: 0.3, filterType: 'lowpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        vibraphone: { attack: 0.01, decay: 0.6, sustain: 0.1, release: 1.2, distortion: 0, brightness: 2.2, resonance: 1.5, chorus: 2, echo: 0.1, reverbMix: 0.4, osc1: 'sine', osc2: 'triangle', osc2Mult: 1, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 5.8, vibrato: 0, sweep: 0, tremolo: 0.5, detune: 1, subOsc: 0, noise: 0, overtones: 0.3, oscMix: 0.4, filterType: 'lowpass', glide: 0, lfoDelay: 0.4, lfoFade: 0.5, lfoKeytrack: 0, lfoPolarity: 'unipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        steelpan: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.5, distortion: 2, brightness: 4.5, resonance: 5.0, chorus: 8, echo: 0.15, reverbMix: 0.3, osc1: 'triangle', osc2: 'sine', osc2Mult: 1.5, filterEnv: 3.0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 10, subOsc: 0.1, noise: 0.05, overtones: 0.5, oscMix: 0.5, filterType: 'bandpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 },
        gamelan: { attack: 0.01, decay: 0.8, sustain: 0.2, release: 1.5, distortion: 1, brightness: 5.0, resonance: 3.0, chorus: 15, echo: 0.2, reverbMix: 0.4, osc1: 'square', osc2: 'sine', osc2Mult: 2.5, filterEnv: 0, lfoShape: 'sine', lfoSync: 'free', lfoSpeed: 0, vibrato: 0, sweep: 0, tremolo: 0, detune: 25, subOsc: 0.1, noise: 0.02, overtones: 0.6, oscMix: 0.4, filterType: 'bandpass', glide: 0, lfoDelay: 0, lfoFade: 0, lfoKeytrack: 0, lfoPolarity: 'bipolar', osc2Pitch: 0, sampleStart: 0, modWheel: 0 }
    };

    // --- DISSONANCE CALCULATOR FOR HARMONY HEATMAP ---
    function calculateDissonance(baseMidiNotes, targetMidiNotes) {
        if (baseMidiNotes.length === 0 || targetMidiNotes.length === 0) return 0.5;

        const basePCs = baseMidiNotes.map(n => Math.round(n) % 12);
        const targetPCs = targetMidiNotes.map(n => Math.round(n) % 12);

        let tensionScore = 0;

        let sharedNotes = 0;
        targetPCs.forEach(pc => { if (basePCs.includes(pc)) sharedNotes++; });

        if (targetPCs.length > 1 && sharedNotes === targetPCs.length && targetPCs.length === basePCs.length) return 0.0;
        if (targetPCs.length === 1 && sharedNotes === 1) return 0.0;

        tensionScore -= (sharedNotes * 0.2);

        const baseRoot = (currentIdentifiedRootPC !== null) ? currentIdentifiedRootPC : basePCs[0];

        // --- DYNAMIC WEIGHT INJECTION ---
        // Fetch the weights for the currently selected genre!
        const intervalWeights = heatmapProfiles[currentHeatmapProfile] || heatmapProfiles['jazz'];

        let maxTension = 0;
        let totalIntervalTension = 0;

        targetPCs.forEach(pc => {
            const interval = (pc - baseRoot + 12) % 12;
            const w = intervalWeights[interval];
            totalIntervalTension += w;
            if (w > maxTension) maxTension = w;
        });

        const avgTension = totalIntervalTension / targetPCs.length;
        tensionScore += (avgTension * 0.4) + (maxTension * 0.6);

        return Math.max(0.0, Math.min(1.0, tensionScore));
    }

    function updateHarmonicHeatmap() {
        if (!isHeatmapActive || heatmapBaseNotes.length === 0) return;
        if (!cachedGridNodes) return;

        // ==========================================
        // --- NEW: BPM-DEPENDENT TRANSITION SPEED ---
        // ==========================================
        // Base transition is 60% of a quarter note beat. 
        // At 120 BPM, this is 0.3s. At 60 BPM, this is 0.6s.
        const beatSecs = 60 / currentArpBPM;
        // Clamp it: Never faster than 0.15s (prevents strobing), never slower than 0.6s (prevents lag)
        const transSecs = Math.max(0.15, Math.min(0.6, beatSecs * 0.6));
        const transitionRule = `fill ${transSecs.toFixed(2)}s ease, opacity ${transSecs.toFixed(2)}s ease`;

        for (let i = 0; i < cachedGridNodes.length; i++) {
            let el = cachedGridNodes[i];
            if (!el._st || el._st.length === 0) continue;

            let targetMidiNotes = el._st.map(st => {
                let f = getFreqFromSt(st);
                return Math.round(12 * Math.log2(f / masterTune) + 69);
            });

            const tension = calculateDissonance(heatmapBaseNotes, targetMidiNotes);
            const curvedTension = Math.pow(tension, 0.75);
            const hue = 120 - (curvedTension * 120);

            const isOutOfScale = currentScale !== 'all' && el.classList.contains('dimmed-scale');

            if (isOutOfScale) {
                const ghostColor = `hsl(${hue}, 50%, 20%)`;
                el.style.setProperty('fill', ghostColor, 'important');
                el.style.setProperty('opacity', '1', 'important');
            } else {
                const lightness = 45 - (Math.abs(60 - hue) * 0.1);
                const vibrantColor = `hsl(${hue}, 85%, ${lightness}%)`;
                el.style.setProperty('fill', vibrantColor, 'important');
                el.style.setProperty('opacity', '1', 'important');
            }

            // ==========================================
            // --- FUNCTIONAL & SEQUENCE GRAVITY BORDERS ---
            // ==========================================
            if (el._highlightEl) {
                el._highlightEl.classList.remove('gravity-border-local', 'gravity-border-sequence');
            }

            if (currentGravityTargets.length > 0) {
                const elRootPC = ((el._st[0] % 12) + 12) % 12;

                if (currentGravityTargets.includes(elRootPC) && el._highlightEl) {
                    if (isStrongSequence) {
                        el._highlightEl.classList.add('gravity-border-sequence');
                    } else {
                        el._highlightEl.classList.add('gravity-border-local');
                    }
                }
            }

            el.style.transition = transitionRule;
        }

        // ==========================================
        // --- TEXT LABEL HIGHLIGHTING ---
        // ==========================================
        if (!cachedTextNodes) cachedTextNodes = document.querySelectorAll('.label-text');

        for (let i = 0; i < cachedTextNodes.length; i++) {
            let textEl = cachedTextNodes[i];

            // Strip old classes
            textEl.classList.remove('gravity-text-local', 'gravity-text-sequence');

            if (currentGravityTargets.length > 0) {
                // Read the pitch class assigned to the text element
                const pc = parseInt(textEl.getAttribute('data-pc'));

                if (currentGravityTargets.includes(pc)) {
                    if (isStrongSequence) {
                        textEl.classList.add('gravity-text-sequence');
                    } else {
                        textEl.classList.add('gravity-text-local');
                    }
                }
            }
        }
    }

    function getOrCreateAcousticWave(overtoneValue) {
        if (!audioCtx || overtoneValue === 0) return null;

        // Use a fixed precision key (e.g., 2 decimals) to prevent floating-point cache misses
        const cacheKey = overtoneValue.toFixed(2);

        if (acousticWaveCache.has(cacheKey)) {
            return acousticWaveCache.get(cacheKey);
        }

        overtoneReal.fill(0);
        overtoneImag.fill(0);
        overtoneImag[1] = 1; // Fundamental

        for (let i = 2; i < numHarmonics; i++) {
            overtoneImag[i] = overtoneValue * (1 / i);
        }

        const wave = audioCtx.createPeriodicWave(overtoneReal, overtoneImag, { disableNormalization: false });
        acousticWaveCache.set(cacheKey, wave);
        return wave;
    }

    function createSahCurve() {
        const size = 4096;
        const curve = new Float32Array(size);
        const steps = 64; // Creates 64 distinct random holds per cycle
        const stepSize = size / steps;
        for (let i = 0; i < steps; i++) {
            const val = Math.random() * 2 - 1;
            for (let j = 0; j < stepSize; j++) {
                curve[Math.floor(i * stepSize + j)] = val;
            }
        }
        return curve;
    }

    function buildLfoChain() {
        if (!audioCtx) return;
        if (globalLfoBase) {
            globalLfoBase.stop(); globalLfoBase.disconnect();
        }
        if (sahShaper) sahShaper.disconnect();

        globalLfoBase = audioCtx.createOscillator();

        // 1. Establish the Master LFO Bus if it doesn't exist
        if (!globalLfoOutput) {
            globalLfoOutput = audioCtx.createGain();
            globalLfoPolarityGain = audioCtx.createGain();
            globalLfoPolarityOffset = audioCtx.createConstantSource();
            globalLfoPolarityOffset.start();

            globalLfoPolarityGain.connect(globalLfoOutput);
            globalLfoPolarityOffset.connect(globalLfoOutput);
        }

        // 2. Unipolar vs Bipolar Math
        if (currentLfoPolarity === 'unipolar') {
            globalLfoPolarityGain.gain.value = 0.5;
            globalLfoPolarityOffset.offset.value = 0.5;
        } else {
            globalLfoPolarityGain.gain.value = 1.0;
            globalLfoPolarityOffset.offset.value = 0.0;
        }

        // 3. Shape Generation (S&H Intercept)
        if (currentLfoShape === 'sah') {
            globalLfoBase.type = 'sawtooth';
            if (!sahShaper) {
                sahShaper = audioCtx.createWaveShaper();
                sahShaper.curve = createSahCurve();
            }
            globalLfoBase.connect(sahShaper);
            sahShaper.connect(globalLfoPolarityGain);
        } else {
            globalLfoBase.type = currentLfoShape;
            globalLfoBase.connect(globalLfoPolarityGain);
        }

        updateLfoSpeed();
        globalLfoBase.start();
    }

    function makeDistortionCurve(amount) {
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);

        if (amount === 0) {
            for (let i = 0; i < n_samples; ++i) {
                curve[i] = (i * 2) / n_samples - 1;
            }
            return curve;
        }

        const k = amount * 1.5;
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    function createImpulseResponse(audioCtx, duration, decay) {
        const length = audioCtx.sampleRate * duration;
        const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
        for (let i = 0; i < 2; i++) {
            const channel = impulse.getChannelData(i);
            for (let j = 0; j < length; j++) channel[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / length, decay);
        }
        return impulse;
    }

    document.getElementById('transpose')?.addEventListener('change', e => currentTranspose = parseInt(e.target.value));
    document.getElementById('tuningMode')?.addEventListener('change', e => currentTuning = e.target.value);
    document.getElementById('btnSnapToScale')?.addEventListener('click', e => {
        snapToScale = !snapToScale;
        e.target.textContent = `Snap to Scale: ${snapToScale ? 'ON' : 'OFF'}`;
        e.target.classList.toggle('active-btn', snapToScale);
    });

    const updateLabel = (id, val, prefix, suffix = '') => {
        const lbl = document.getElementById('lbl' + id.charAt(0).toUpperCase() + id.slice(1));
        if (lbl) lbl.textContent = `${prefix}: ${val}${suffix}`;
    };

    document.getElementById('maxVoices')?.addEventListener('input', e => {
        maxVoices = parseInt(e.target.value);
        updateLabel('maxVoices', maxVoices, 'Polyphony');
    });

    // --- SAMPLER ENGINE UI & DECODING ---
    async function loadSampleToBuffer(id, url) {
        initAudio();
        
        // If we already decoded this exact sample, we're good!
        if (sampleBank.has(id)) return;
        if (!url) return; 

        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            registerSample(id, decodedBuffer);
        } catch (e) {
            console.error("Error loading sample:", e);
        }
    }

    document.getElementById('btnLoadCustomSample')?.addEventListener('click', () => {
        document.getElementById('customSampleInput').click();
    });

    document.getElementById('customSampleInput')?.addEventListener('change', async (e) => {
        const files = e.target.files;
        const presetEl = document.getElementById('instrumentPreset');
        if (!files || files.length === 0) return;

        // Explicitly wake up the audio context to prevent browser hang bugs
        if (typeof initAudio === 'function') initAudio();
        if (audioCtx && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
            await audioCtx.resume();
        }

        showToast(`Processing ${files.length} custom sample(s)...`);
        let lastFileName = "";

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                lastFileName = file.name;
                
                const arrayBuffer = await file.arrayBuffer();
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                const dictKey = `sample_db:${file.name}`;
                registerSample(dictKey, decodedBuffer);

                if (typeof saveSampleToDB === 'function') await saveSampleToDB(file);
            }

            if (presetEl && lastFileName) {
                const targetValue = `sample_db:${lastFileName}`;
                
                // Guarantee the option exists in the HTML before trying to select it!
                const optionExists = Array.from(presetEl.options).some(opt => opt.value === targetValue);
                if (!optionExists) {
                    const newOpt = document.createElement('option');
                    newOpt.value = targetValue;
                    newOpt.textContent = cleanLabelName(lastFileName); 
                    presetEl.appendChild(newOpt);
                }

                // Now the browser will successfully accept the assignment and trigger the synth engine
                presetEl.value = targetValue;
                presetEl.dispatchEvent(new Event('change'));
            }
            showToast(`Successfully loaded ${files.length} sample(s)!`);
        } catch (err) {
            console.error(`CRITICAL UPLOAD FAILURE:`, err);
            showToast("Failed to process one or more audio files.");
        }
        e.target.value = '';
    });

    // Intercept the Instrument Dropdown to handle Samplers
    document.getElementById('instrumentPreset')?.addEventListener('change', e => {
        const val = e.target.value;
        isSamplerMode = val.startsWith('sample_');
        const isFolderSample = val.startsWith('sample_folder:');

        // Legacy procedural samples removed. All user wavs default to looping sustain.
        isSamplerLooping = true; 

        // Toggle UI Elements safely
        const grpOscMix = document.getElementById('grpOscMix');
        // Handle both the old ID and the new grouped ID from the recent HTML update
        const grpSamplerControls = document.getElementById('grpSamplerControls'); 
        const grpSampleRoot = document.getElementById('grpSampleRoot');

        if (grpOscMix) grpOscMix.style.display = isSamplerMode ? 'none' : 'flex';
        if (grpSamplerControls) grpSamplerControls.style.display = isSamplerMode ? 'flex' : 'none';
        if (grpSampleRoot) grpSampleRoot.style.display = isSamplerMode ? 'flex' : 'none';

        // --- Gray out controls that do not apply to audio samples ---
        // THE FIX: 'vibrato' removed so it stays active! 'osc2Pitch' added.
        const disabledInSampler = ['detune', 'osc2Pitch', 'subOsc', 'noise', 'overtones'];
        disabledInSampler.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = isSamplerMode; 
                const group = el.closest('.control-group'); 
                if (group) group.style.opacity = isSamplerMode ? '0.3' : '1';
            }
        });

        // Ensure Vibrato is explicitly restored if switching back from a disabled state
        const vibEl = document.getElementById('vibrato');
        if (vibEl) {
            vibEl.disabled = false;
            const vibGroup = vibEl.closest('.control-group');
            if (vibGroup) vibGroup.style.opacity = '1';
        }

        if (isSamplerMode) {
            syncADSR('attack', 0.01); syncADSR('decay', 1.0); syncADSR('sustain', 0.8); syncADSR('release', 0.4);

            // Added modWheel and sampleStart to the zero-out list for a clean sample load
            ['subOsc', 'noise', 'filterEnv', 'tremolo', 'sweep', 'vibrato', 'distortion', 'modWheel', 'sampleStart'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
            });

            const br = document.getElementById('brightness');
            if (br) { br.value = 8; br.dispatchEvent(new Event('input')); }
            
            const rootInput = document.getElementById('sampleRootKey');
            if (rootInput) {
                const detectedMidi = extractMidiFromFilename(val);
                rootInput.value = detectedMidi;
                rootInput.dispatchEvent(new Event('input')); 
            }

            // --- STRICT ROUTING LOGIC ---
            if (val === 'sample_custom') {
                document.getElementById('customSampleInput').click();
                e.target.selectedIndex = 0;
                e.target.dispatchEvent(new Event('change'));
            } else if (isFolderSample) {
                const filePath = val.replace('sample_folder:', '');
                loadSampleToBuffer(val, filePath); 
            } else if (val.startsWith('sample_db:')) {
                const filename = val.replace('sample_db:', '');
                
                // --- FILE:/// CORS BYPASS ---
                // Do NOT use URL.createObjectURL or fetch() here! 
                // Decode the binary array directly to bypass local browser security blocks.
                if (!sampleBank.has(val)) {
                    loadSampleFromDB(filename).then(async arrayBuffer => {
                        if (arrayBuffer) {
                            try {
                                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                                registerSample(val, decodedBuffer);
                            } catch (err) {
                                console.error("Failed to decode DB sample:", err);
                            }
                        } else {
                            showToast("Sample not found in database!");
                        }
                    });
                }
            } else {
                // Safely ignore legacy procedural samples so they don't trigger fetch(null)
            }
        } else {
            // Load Analog Synth Preset
            const p = presets[val]; if (!p) return;
            currentOsc1 = p.osc1; currentOsc2 = p.osc2; currentOsc2Mult = p.osc2Mult;

            // Added osc2Pitch, and replaced autoPan with modWheel
            ['attack', 'decay', 'sustain', 'release', 'distortion', 'brightness', 'chorus', 'echo', 'resonance', 'reverbMix', 'lfoSpeed', 'vibrato', 'sweep', 'tremolo', 'detune', 'osc2Pitch', 'subOsc', 'noise', 'filterEnv', 'overtones', 'modWheel', 'lfoDelay', 'lfoFade', 'lfoKeytrack'].forEach(id => {
                const el = document.getElementById(id);
                if (el && p[id] !== undefined) { el.value = p[id]; el.dispatchEvent(new Event('input')); }
            });

            const shapeEl = document.getElementById('lfoShape');
            if (shapeEl) { shapeEl.value = p.lfoShape || 'sine'; currentLfoShape = shapeEl.value; }
            
            const syncEl = document.getElementById('lfoSync');
            if (syncEl) { syncEl.value = p.lfoSync || 'free'; currentLfoSync = syncEl.value; }
            
            const polarityEl = document.getElementById('lfoPolarity');
            if (polarityEl) { polarityEl.value = p.lfoPolarity || 'bipolar'; currentLfoPolarity = polarityEl.value; }
            
            buildLfoChain(); 
            if (typeof updateLfoSpeed === 'function') updateLfoSpeed();

            if (lfoRetrigger) document.getElementById('btnLfoRetrigger')?.click(); 
        }

        if (typeof drawEnvelope === 'function') drawEnvelope();

        // --- ISOLATED TIMELINE NOTE CLONING ---
        if (typeof studio !== 'undefined') {
            const activeTrack = studio.lastSelectedDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            if (studio.trackTypes[activeTrack] === 'voice' || studio.trackTypes[activeTrack] === null) {
                
                if (!studio.trackSynthStates[activeTrack]) {
                    studio.trackSynthStates[activeTrack] = typeof captureCurrentSynthState === 'function' ? captureCurrentSynthState() : {};
                } else {
                    studio.trackSynthStates[activeTrack] = JSON.parse(JSON.stringify(studio.trackSynthStates[activeTrack]));
                }
                
                studio.trackSynthStates[activeTrack].instrumentPreset = val;

                const trackArray = studio.lastSelectedDomain === 'looper' ? looper.tracks[activeTrack] : arranger.tracks[activeTrack - 8];
                if (trackArray && Array.isArray(trackArray)) {
                    trackArray.forEach(evt => {
                        if (evt.type === 'play' || evt.type === 'stem') {
                            evt.synthState = JSON.parse(JSON.stringify(studio.trackSynthStates[activeTrack]));
                        }
                    });
                }

                if (typeof syncActiveTrackInstrument === 'function') syncActiveTrackInstrument();
            }
        }

        if (typeof updatePianoRollTrackLabel === 'function') updatePianoRollTrackLabel();
        if (typeof syncAllMacros === 'function') syncAllMacros();
    });

    const syncADSR = (id, val) => {
        if (id === 'attack') { currentAttack = val; updateLabel(id, val.toFixed(2), 'Attack', 's'); }
        if (id === 'decay') { currentDecay = val; updateLabel(id, val.toFixed(2), 'Decay', 's'); }
        if (id === 'sustain') { currentSustain = val; updateLabel(id, val.toFixed(2), 'Sustain', ''); }
        if (id === 'release') { currentRelease = val; updateLabel(id, val.toFixed(2), 'Release', 's'); }

        const mainEl = document.getElementById(id);
        if (mainEl) mainEl.value = val;
        drawEnvelope();
    };

    ['attack', 'decay', 'sustain', 'release'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', e => syncADSR(id, parseFloat(e.target.value)));
    });

    function drawEnvelope() {
        const canvas = document.getElementById('envCanvas'); if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width; const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const maxTime = 3.0;
        const aX = Math.min((currentAttack / maxTime) * w, w * 0.3);
        const dX = aX + Math.min((currentDecay / maxTime) * w, w * 0.3);
        const sY = h - (currentSustain * h);
        const sX = w * 0.7;
        const rX = sX + Math.min((currentRelease / maxTime) * w, w * 0.3);

        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(aX, 0);
        ctx.lineTo(dX, sY);
        ctx.lineTo(sX, sY);
        ctx.lineTo(Math.min(rX, w), h);
        ctx.strokeStyle = '#ffeb3b'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = 'rgba(255, 235, 59, 0.2)'; ctx.fill();
    }

document.getElementById('echo')?.addEventListener('input', e => {
    currentEcho = parseFloat(e.target.value);
    updateLabel('echo', currentEcho.toFixed(2), 'Echo');
        
    // ONLY update the track mixer if this was a physical user interaction!
    if (e.isTrusted && typeof audioCtx !== 'undefined' && typeof studio !== 'undefined') {
        const activeDomain = studio.lastSelectedDomain;
        const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        const nodes = activeDomain === 'looper' ? looperEchoSends : linearEchoSends;
        const localIdx = activeDomain === 'looper' ? activeIdx : activeIdx - 8;
            
        if (nodes[localIdx]) nodes[localIdx].gain.setTargetAtTime(currentEcho, audioCtx.currentTime, 0.015);
            
        const mixerSlider = document.querySelector(`.echo-send[data-track="${activeIdx}"]`);
        if (mixerSlider) mixerSlider.value = currentEcho;
    }
});

    document.getElementById('reverbMix')?.addEventListener('input', e => {
        currentReverb = parseFloat(e.target.value);
        updateLabel('reverbMix', currentReverb.toFixed(2), 'Reverb');
        
        // ONLY update the track mixer if this was a physical user interaction!
        if (e.isTrusted && typeof audioCtx !== 'undefined' && typeof studio !== 'undefined') {
            const activeDomain = studio.lastSelectedDomain;
            const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            const nodes = activeDomain === 'looper' ? looperReverbSends : linearReverbSends;
            const localIdx = activeDomain === 'looper' ? activeIdx : activeIdx - 8;
            
            if (nodes[localIdx]) nodes[localIdx].gain.setTargetAtTime(currentReverb, audioCtx.currentTime, 0.015);
            
            const mixerSlider = document.querySelector(`.reverb-send[data-track="${activeIdx}"]`);
            if (mixerSlider) mixerSlider.value = currentReverb;
        }
    });

    document.getElementById('autoPan')?.addEventListener('input', e => {
        currentAutoPan = parseFloat(e.target.value);
        if (lfoPanGain) lfoPanGain.gain.setTargetAtTime(currentAutoPan, audioCtx.currentTime, 0.05);
        updateLabel('autoPan', Math.round(currentAutoPan * 100), 'Pan', '%');
    });
    document.querySelectorAll('.pan-slider').forEach(slider => {
        slider.addEventListener('input', e => {
            const trackIdx = parseInt(e.target.getAttribute('data-track'));
            const nodes = trackIdx < 8 ? looperPanners : linearPanners;
            const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
            if (nodes[localIdx]) nodes[localIdx].pan.value = parseFloat(e.target.value);
        });
    });

    // --- ADVANCED LFO ENGINE ---
    function retriggerLFO() {
        if (!lfoRetrigger || !audioCtx) return;
        buildLfoChain(); // Rebuilding the chain instantly resets the phase!
    }

    function updateLfoSpeed() {
        let speed = currentLfoSpeed;

        // 1. BPM Sync Math
        if (currentLfoSync === 'sync') {
            const bps = currentArpBPM / 60;
            const multipliers = [0.125, 0.25, 0.5, 1, 1.5, 2, 3, 4, 8];
            speed = multipliers.reduce((prev, curr) =>
                Math.abs(curr * bps - currentLfoSpeed) < Math.abs(prev * bps - currentLfoSpeed) ? curr : prev
            ) * bps;
        }

        // 2. Keytracking Math
        if (lastPlayedFreq && currentLfoKeytrack > 0) {
            const midiNote = Math.round(12 * Math.log2(lastPlayedFreq / masterTune) + 69);
            const trackingMult = Math.pow(2, (midiNote - 60) / 12);
            // Scales speed up/down based on distance from Middle C (60)
            speed = speed * (1 + ((trackingMult - 1) * (currentLfoKeytrack / 100)));
        }

        if (globalLfoBase && audioCtx) {
            globalLfoBase.frequency.setTargetAtTime(speed, audioCtx.currentTime, 0.05);
        }
    }

    document.getElementById('lfoSpeed')?.addEventListener('input', e => {
        currentLfoSpeed = parseFloat(e.target.value);
        updateLfoSpeed();
        updateLabel('lfoSpeed', currentLfoSpeed.toFixed(1), 'Speed', ' Hz');
    });

    document.getElementById('vibrato')?.addEventListener('input', e => {
        currentVibrato = parseFloat(e.target.value);
        if (audioCtx) activeNodes.forEach(n => n.voices.forEach(v => { if (v.vPitchGain) v.vPitchGain.gain.setTargetAtTime(currentVibrato, audioCtx.currentTime, 0.05); }));
        updateLabel('vibrato', currentVibrato, 'Vib');
    });

    document.getElementById('sweep')?.addEventListener('input', e => {
        currentSweep = parseFloat(e.target.value);
        if (audioCtx) activeNodes.forEach(n => n.voices.forEach(v => { if (v.vFilterGain) v.vFilterGain.gain.setTargetAtTime(currentSweep, audioCtx.currentTime, 0.05); }));
        updateLabel('sweep', currentSweep, 'Sweep');
    });

    document.getElementById('tremolo')?.addEventListener('input', e => {
        currentTremolo = parseFloat(e.target.value);
        if (audioCtx) activeNodes.forEach(n => n.voices.forEach(v => { if (v.vAmpGain) v.vAmpGain.gain.setTargetAtTime(currentTremolo, audioCtx.currentTime, 0.05); }));
        updateLabel('tremolo', currentTremolo.toFixed(2), 'Trem');
    });

    document.getElementById('lfoShape')?.addEventListener('change', e => {
        currentLfoShape = e.target.value;
        buildLfoChain(); // S&H requires rebuilding the chain
    });

    document.getElementById('lfoPolarity')?.addEventListener('change', e => {
        currentLfoPolarity = e.target.value;
        buildLfoChain();
    });

    document.getElementById('lfoSync')?.addEventListener('change', e => {
        currentLfoSync = e.target.value; updateLfoSpeed();
    });

    document.getElementById('btnLfoRetrigger')?.addEventListener('click', e => {
        lfoRetrigger = !lfoRetrigger;
        e.target.textContent = `Key Sync: ${lfoRetrigger ? 'ON' : 'OFF'}`;
        e.target.classList.toggle('active-btn', lfoRetrigger);
    });

    document.getElementById('lfoDelay')?.addEventListener('input', e => {
        currentLfoDelay = parseFloat(e.target.value);
        updateLabel('lfoDelay', currentLfoDelay.toFixed(2), 'Delay', 's');
    });

    document.getElementById('lfoFade')?.addEventListener('input', e => {
        currentLfoFade = parseFloat(e.target.value);
        updateLabel('lfoFade', currentLfoFade.toFixed(2), 'Fade', 's');
    });

    document.getElementById('lfoKeytrack')?.addEventListener('input', e => {
        currentLfoKeytrack = parseInt(e.target.value);
        updateLabel('lfoKeytrack', currentLfoKeytrack, 'Keytrack', '%');
        if (typeof updateLfoSpeed === 'function') updateLfoSpeed();
    });

    document.getElementById('lfoPolarity')?.addEventListener('change', e => {
        currentLfoPolarity = e.target.value;
    });

    document.getElementById('detune')?.addEventListener('input', e => {
        currentDetune = parseFloat(e.target.value);
        if (audioCtx) { 
            activeNodes.forEach(nodeData => nodeData.voices.forEach(({ osc2, freq }) => {
                if (osc2) {
                    osc2.frequency.setTargetAtTime(freq * Math.pow(2, currentDetune / 1200) * currentOsc2Mult, audioCtx.currentTime, 0.05);
                }
            })); 
        }
        updateLabel('detune', currentDetune, 'Detune');
    });

    document.getElementById('subOsc')?.addEventListener('input', e => {
        currentSubOsc = parseFloat(e.target.value);
        updateLabel('subOsc', currentSubOsc.toFixed(2), 'Sub Osc');
    });

    document.getElementById('noise')?.addEventListener('input', e => {
        currentNoise = parseFloat(e.target.value);
        updateLabel('noise', currentNoise.toFixed(2), 'Noise');
    });

    document.getElementById('overtones')?.addEventListener('input', e => {
        currentOvertones = parseFloat(e.target.value);
        if (typeof updateLabel === 'function') updateLabel('overtones', currentOvertones, 'Overtones', '%', true);
    });

    document.getElementById('filterEnv')?.addEventListener('input', e => {
        currentFilterEnv = parseFloat(e.target.value);
        updateLabel('filterEnv', currentFilterEnv.toFixed(1), 'Filter Env');
    });

    document.getElementById('brightness')?.addEventListener('input', e => {
        currentBrightness = parseFloat(e.target.value);
        if (audioCtx) { activeNodes.forEach(nodeData => nodeData.voices.forEach(({ filter, freq }) => filter.frequency.setTargetAtTime(Math.min(freq * currentBrightness, 12000), audioCtx.currentTime, 0.05))); }
        updateLabel('brightness', currentBrightness.toFixed(1), 'Brightness');
    });

    document.getElementById('resonance')?.addEventListener('input', e => {
        currentResonance = parseFloat(e.target.value);
        if (audioCtx) { activeNodes.forEach(nodeData => nodeData.voices.forEach(({ filter }) => filter.Q.setTargetAtTime(currentResonance, audioCtx.currentTime, 0.05))); }
        updateLabel('resonance', currentResonance.toFixed(1), 'Resonance');
    });

    document.getElementById('distortion')?.addEventListener('input', e => {
        currentDistortion = parseFloat(e.target.value);
        if (distortionNode) {
            distortionNode.curve = makeDistortionCurve(currentDistortion);
            distortionNode.oversample = isMobileDevice ? (currentDistortion > 0 ? '2x' : 'none') : '4x';
        }
        updateLabel('distortion', currentDistortion, 'Distortion');
    });

    document.getElementById('chorus')?.addEventListener('input', e => {
        currentChorus = parseFloat(e.target.value);
        if (audioCtx) { 
            activeNodes.forEach(nodeData => nodeData.voices.forEach(({ osc2, freq }) => {
                if (osc2) {
                    osc2.frequency.setTargetAtTime(freq * Math.pow(2, currentChorus / 1200) * currentOsc2Mult, audioCtx.currentTime, 0.05);
                }
            })); 
        }
        updateLabel('chorus', currentChorus, 'Chorus');
    });

    document.getElementById('oscMix')?.addEventListener('input', e => { currentOscMix = parseFloat(e.target.value); updateLabel('oscMix', Math.round(currentOscMix * 100), 'Osc Mix (1-2)', '%'); });
    document.getElementById('glide')?.addEventListener('input', e => { currentGlide = parseFloat(e.target.value); const lbl = document.getElementById('lblGlideText'); if (lbl) lbl.textContent = `Glide: ${currentGlide.toFixed(2)}s`; });
    document.getElementById('filterType')?.addEventListener('change', e => { currentFilterType = e.target.value; });

    document.getElementById('sampleRootKey')?.addEventListener('input', e => {
        currentSampleRootKey = parseInt(e.target.value) || 60;
        
        const activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
        const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        const localIdx = activeDomain === 'looper' ? activeIdx : activeIdx - 8;
        const domainObj = activeDomain === 'looper' ? looper : arranger;
        
        // 1. Update the active track's saved memory state
        if (studio.trackSynthStates[activeIdx]) {
            studio.trackSynthStates[activeIdx].sampleRootKey = currentSampleRootKey;
        }

        // 2. Retroactively apply this new root key to all existing notes on the track!
        domainObj.tracks[localIdx].forEach(evt => {
            if (evt.type === 'play' && evt.synthState) {
                evt.synthState.sampleRootKey = currentSampleRootKey;
            }
        });
    });

    // MIDI additions
    document.getElementById('midiSyncMode')?.addEventListener('change', e => {
        midiSyncMode = e.target.value;
        const bpmSlider = document.getElementById('arpBpm');
        if (bpmSlider) {
            // If we are slaved to external hardware, disable the manual BPM slider!
            bpmSlider.disabled = (midiSyncMode === 'slave');
            bpmSlider.style.opacity = (midiSyncMode === 'slave') ? '0.5' : '1';
        }
    });
    document.getElementById('midiVelocity')?.addEventListener('input', e => { currentVelocity = parseInt(e.target.value); updateLabel('midiVelocity', currentVelocity, 'Velocity'); });

    // Link the Legacy MIDI Tab Slider (0-127)
    document.getElementById('midiModWheel')?.addEventListener('input', e => {
        const val127 = parseInt(e.target.value);
        setModWheel(val127 / 127.0); // Convert to 0.0-1.0 and pipe it to the brain
    });

    // Link the new Synth Overlay Slider (0.0-1.0)
    document.getElementById('modWheel')?.addEventListener('input', e => {
        setModWheel(parseFloat(e.target.value)); 
    });

    // --- LIVE PLAY EXPRESSION: Mouse Wheel Hijack ---
    window.addEventListener('wheel', (e) => {
        // Only hijack the wheel if notes are actively being held down
        if ((typeof activeUserNotes !== 'undefined' && activeUserNotes > 0) || 
            (typeof sustainedVoices !== 'undefined' && sustainedVoices.size > 0)) {
            
            e.preventDefault(); // Stop the Tonnetz from zooming
            
            // Scroll up = increase, Scroll down = decrease
            const newVal = currentModWheel - (e.deltaY * 0.002);
            setModWheel(newVal);
        }
    }, { passive: false }); // passive: false is required so e.preventDefault() works!

    const pbSlider = document.getElementById('midiPitchBend');
    const sendPitchBend = (val) => {
        if (!midiOut) return;
        const pbVal = val + 8192; // MIDI pitch bend is 0 to 16383, center is 8192
        const lsb = pbVal & 0x7F; const msb = (pbVal >> 7) & 0x7F;
        for (let c = 0; c < 16; c++) midiOut.send([0xE0 + c, lsb, msb]);
    };
    pbSlider?.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        updateLabel('midiPitchBend', val === 0 ? 'Center' : val, 'Pitch Bend'); sendPitchBend(val);
    });
    // Snap Pitch Bend back to center on release!
    const snapPitchBend = () => { if (pbSlider) { pbSlider.value = 0; updateLabel('midiPitchBend', 'Center', 'Pitch Bend'); sendPitchBend(0); } };
    pbSlider?.addEventListener('mouseup', snapPitchBend); pbSlider?.addEventListener('touchend', snapPitchBend);

    // --- SAMPLER ENGINE UI & DECODING ---
    async function loadSampleToBuffer(id, url) {
        initAudio();
        
        // If we already decoded this exact sample, we're good!
        if (sampleBank.has(id)) return;
        
        // IMMUNITY BLOCK: Prevent 'null' strings from causing CORS console errors
        if (!url || url === 'null' || url === 'undefined') return; 

        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            
            sampleBank.set(id, decodedBuffer); 
        } catch (e) {
            console.error(`Error loading sample ${id} via network:`, e);
        }
    }

    // ==========================================
    // AI PROGRESSION GENERATOR ENGINE
    // ==========================================

    // --- Temporal Net Context Scanner ---
    // Scans a specific window of time (e.g., 1 full bar) and collapses all 
    // played notes (like arpeggios) into a single harmonic block.
    function getAggregatedChordForWindow(startTime, duration, activeDomain, targetTrackIdx) {
        let activePcs = new Set();
        let lowestMidi = Infinity;

        const scanEngine = (engineObj, isLooper) => {
            if (!engineObj || !engineObj.tracks) return;
            engineObj.tracks.forEach((track, trackIdx) => {
                // Skip the track we are currently generating onto!
                if (isLooper === (activeDomain === 'looper') && trackIdx === targetTrackIdx) return;
                const trackType = studio.trackTypes[isLooper ? trackIdx : trackIdx + 8];
                if (trackType === 'drum') return; 

                track.forEach(evt => {
                    if (evt.type === 'play' && evt.freqs) {
                        const startT = evt.timeOffset;
                        const endT = evt.timeOffset + (evt.duration || 0.25);
                        
                        // If the note overlaps with our scanning window at ALL, catch it!
                        if (startT < startTime + duration && endT > startTime) {
                            evt.freqs.forEach(f => {
                                if (isFinite(f)) {
                                    const midi = Math.round(12 * Math.log2(f / masterTune) + 69);
                                    activePcs.add(((midi % 12) + 12) % 12);
                                    if (midi < lowestMidi) lowestMidi = midi;
                                }
                            });
                        }
                    }
                });
            });
        };

        scanEngine(arranger, false);
        scanEngine(looper, true);

        if (activePcs.size === 0) return null; // No context found!

        // Reconstruct a sensible chord array from the aggregated pitch classes
        const bassPc = lowestMidi === Infinity ? 0 : (lowestMidi % 12);
        let pcs = Array.from(activePcs).sort((a, b) => a - b);
        
        // Build the chord in Octave 4 (Midi 48)
        let midiArray = pcs.map(pc => {
            let m = 48 + pc; 
            if (m < 48 + bassPc) m += 12; // Keep the detected bass note strictly at the bottom
            return m;
        }).sort((a, b) => a - b);

        return midiArray;
    }

    const progressionLibrary = {
        pop: [
            // 4-Chord Loops
            [1, 5, 6, 4], // Classic Pop Anthem
            [4, 5, 3, 6], // "The Royal Road" (Modern Pop/K-Pop)
            [1, 4, 6, 5], // Upbeat / Driving Pop
            [6, 4, 1, 5], // "Sensitive" Pop 
            // 8-Chord Phrases (Question & Answer)
            [1, 5, 6, 3, 4, 1, 4, 5], // Pachelbel's Narrative (Great storytelling)
            [1, 4, 1, 5, 1, 4, 6, 5], // Verse to Chorus build
            [4, 5, 6, 1, 4, 5, 3, 6], // Royal Road extended turnaround
            [6, 4, 1, 5, 6, 4, 2, 5]  // Minor epic pop build
        ],
        dark: [
            // 4-Chord Loops
            [6, 4, 1, 5], // Standard Melancholy
            [6, 5, 4, 3], // Andalusian Cadence (Classic descending tension)
            [6, 3, 4, 2], // Unsettled & Moody
            [6, 2, 4, 3], // Tense & Restless
            // 8-Chord Phrases
            [6, 4, 7, 3, 6, 2, 4, 5], // Extended Dark Narrative
            [6, 5, 4, 3, 6, 5, 2, 3], // Andalusian variation (Tragic end)
            [6, 4, 1, 5, 6, 4, 3, 3], // Lingering, unresolved tension
            [6, 1, 4, 5, 6, 1, 2, 3]  // Gothic rise and fall
        ],
        jazz: [
            // 4-Chord Loops
            [2, 5, 1, 6], // The "Coltrane" Turnaround
            [2, 5, 1, 4], // "Just the Two of Us" movement
            [3, 6, 2, 5], // Rhythm Changes intro
            [1, 4, 7, 3], // Circle of Fifths sequence
            // 8-Chord Phrases
            [3, 6, 2, 5, 1, 4, 7, 3], // "Autumn Leaves" (Full circle resolution)
            [1, 6, 2, 5, 3, 6, 2, 5], // Rhythm Changes extended turnaround
            [2, 5, 1, 6, 2, 5, 1, 1], // Standard turnaround to resolution
            [1, 4, 3, 6, 2, 5, 1, 5]  // "Bird" blues turnaround feel
        ],
        soul: [
            // 4-Chord Loops
            [4, 3, 2, 1], // Classic descending Neo-Soul
            [2, 5, 3, 6], // Vintage Motown turnaround
            [4, 5, 3, 6], // Emotional Lift
            [1, 2, 3, 4], // Ascending "My Girl" progression
            // 8-Chord Phrases
            [4, 3, 6, 1, 2, 5, 1, 1], // Extended Gospel/Soul cadence
            [1, 4, 1, 4, 3, 6, 2, 5], // Classic verse to pre-chorus tension
            [4, 5, 3, 6, 2, 5, 1, 1], // Lift and resolve
            [1, 6, 2, 5, 3, 6, 4, 5]  // Extended Motown bounce
        ],
        epic: [ 
            // 4-Chord Loops
            [1, 6, 3, 7], // The "Zimmer" / Interstellar feel
            [6, 4, 1, 5], // Heroic Minor
            [1, 5, 6, 4], // Triumphant Major
            [6, 7, 1, 2], // Building Tension
            // 8-Chord Phrases
            [1, 4, 6, 5, 1, 4, 2, 5], // Extended Triumphant Journey
            [6, 4, 1, 5, 6, 4, 5, 5], // Heroic build holding on the Dominant
            [1, 5, 6, 3, 4, 1, 5, 5], // Triumphant march holding tension
            [6, 7, 1, 4, 6, 7, 2, 3]  // Modulating Cinematic tension
        ],
        lofi: [
            // 4-Chord Loops
            [4, 3, 2, 1], // Chill descending
            [2, 5, 1, 6], // Jazzy Loop
            [4, 5, 6, 1], // Nostalgic & Dreamy
            [4, 3, 6, 5], // Melancholic resolution
            // 8-Chord Phrases
            [2, 5, 1, 4, 7, 3, 6, 6], // Floating, unresolved loop (Keeps listener hooked)
            [4, 3, 2, 1, 4, 3, 6, 5], // Chill drop variation
            [4, 5, 3, 6, 2, 5, 1, 6], // "Anime" Lofi extended sequence
            [1, 2, 3, 4, 3, 2, 1, 1]  // Lazy day ascending/descending sweep
        ],
        classical: [
            // 4-Chord Loops
            [1, 4, 5, 1], // Perfect Authentic Cadence
            [1, 6, 2, 5], // Standard progression
            [1, 4, 6, 5], // Deceptive Setup
            [6, 4, 1, 5], // Minor Sonata theme
            // 8-Chord Phrases
            [1, 5, 6, 3, 4, 1, 2, 5], // Canon in D movement
            [1, 4, 1, 5, 1, 4, 5, 1], // Symphony Resolution
            [1, 6, 4, 2, 5, 1, 5, 1], // Mozart-style Cadence
            [6, 2, 5, 1, 4, 2, 3, 6]  // Minor classical sequence
        ],
        rnb: [
            // 4-Chord Loops
            [4, 5, 6, 2], // Modern R&B tension
            [1, 4, 2, 5], // Smooth 90s Groove
            [4, 3, 2, 6], // Moody Trap-Soul
            [2, 5, 1, 6], // Vintage R&B
            // 8-Chord Phrases
            [4, 3, 6, 5, 4, 3, 2, 5], // Extended Narrative
            [2, 5, 3, 6, 4, 5, 1, 1], // 90s Boyband bridge resolution
            [4, 5, 6, 1, 4, 5, 2, 3], // Modern trap-soul build
            [1, 6, 2, 5, 1, 6, 4, 5]  // Smooth 8-bar groove
        ],
        synthwave: [ 
            // 4-Chord Loops
            [6, 4, 1, 5], // The "Drive" progression
            [4, 6, 5, 5], // Driving night feel
            [1, 4, 6, 5], // 80s upbeat
            [6, 2, 4, 5], // Dark synth pop
            // 8-Chord Phrases
            [6, 4, 1, 5, 6, 4, 2, 3], // Dark neon drive (Ends on tense III)
            [4, 5, 6, 1, 4, 5, 6, 3], // Outrun training montage
            [1, 6, 4, 5, 1, 6, 2, 5], // 80s teen movie anthem
            [6, 5, 4, 5, 6, 5, 2, 3]  // Cyberpunk tension loop
        ],
        edm: [
            // 4-Chord Loops (High Energy)
            [6, 4, 1, 5], // The classic "Festival/Big Room" anthem
            [1, 6, 4, 5], // Trance builder
            [4, 6, 5, 5], // Driving progressive house
            [6, 5, 4, 5], // Tense drop buildup
            // 8-Chord Phrases (Mainstage Narratives)
            [4, 1, 5, 6, 4, 1, 5, 5], // 8-bar Mainstage progression (tension to release)
            [6, 4, 1, 5, 6, 4, 5, 5], // Minor festival build, resting on dominant
            [1, 5, 6, 4, 1, 5, 4, 5], // Uplifting vocal EDM verse
            [6, 5, 4, 3, 6, 5, 4, 5]  // Phrygian/Dark descent to big rise
        ],
        house: [
            // 4-Chord Loops (Groove & Soul)
            [2, 5, 1, 6], // Deep House (Usually played with minor 7ths/9ths)
            [1, 4, 1, 4], // 2-chord vamp (very common in tech house)
            [4, 3, 2, 1], // Descending soulful house
            [6, 7, 1, 2], // Ascending piano house progression
            // 8-Chord Phrases (Extended Mix Grooves)
            [2, 2, 3, 6, 2, 2, 4, 5], // Extended funky house progression
            [4, 3, 2, 1, 4, 3, 6, 6], // Soulful house with a minor turnaround
            [2, 5, 1, 6, 2, 5, 3, 6], // Deep house jazzy turnaround
            [1, 4, 5, 4, 1, 4, 6, 5]  // Classic 90s piano house extended loop
        ],
        techno: [
            // 4-Chord Loops (Hypnotic & Static)
            [1, 1, 1, 1], // Pure pedal-point driving techno
            [1, 1, 1, 7], // Detroit techno bump
            [1, 2, 1, 7], // Dark minimal shift
            [6, 6, 6, 5], // Minor underground loop
            // 8-Chord Phrases (Slow Modulations)
            [1, 1, 1, 1, 1, 1, 1, 7], // Long hypnotic drive with a 1-bar turnaround
            [6, 6, 6, 6, 6, 6, 4, 5], // Melodic techno/Berlin build
            [1, 2, 1, 2, 1, 2, 3, 4], // Acid techno climbing sequence
            [1, 1, 4, 4, 1, 1, 5, 5]  // Tech-house blocky chord stabs
        ],
        pop_punk: [
            // 4-Chord Loops (Fast & Power Chords)
            [1, 5, 6, 4], // The Blink-182 classic
            [6, 4, 1, 5], // The heavy emo chorus
            [1, 4, 1, 5], // Fast drive
            [4, 1, 6, 5], // Emotional bridge
            // 8-Chord Phrases (Pop-Punk Verse/Chorus)
            [1, 5, 6, 4, 1, 5, 4, 4], // Anthem chorus ending on subdominant
            [6, 4, 1, 5, 6, 4, 5, 5], // Emo narrative holding tension
            [1, 4, 6, 5, 1, 4, 2, 5], // Skate-punk driving verse
            [4, 1, 5, 6, 4, 1, 5, 5]  // 2000s Pop-Rock buildup
        ],
        jazz_bossa: [ 
            // 4-Chord Loops (Smooth & Syncopated)
            [1, 6, 2, 5], // The standard turnaround
            [2, 5, 3, 6], // Rising sequence
            [1, 2, 3, 4], // Ascending "Girl from Ipanema" vibe
            [3, 6, 2, 5], // Secondary dominant chain
            // 8-Chord Phrases (Extended Cafe Grooves)
            [4, 4, 3, 6, 2, 5, 1, 1], // 8-bar Bossa sequence
            [1, 6, 2, 5, 3, 6, 2, 5], // Extended turnaround chain
            [2, 5, 1, 6, 2, 5, 1, 1], // Lounge jazz resolution
            [3, 6, 2, 5, 1, 4, 7, 3]  // "Autumn Leaves" full circle
        ]
    };

    // [WEIGHTS: Shift, Invert, Retrograde, Truncate, Diminution, Augmentation]
    const variationProfiles = {
        pop: { shift: 60, invert: 10, retro: 0, trunc: 30, dim: 0, aug: 0 },
        rnb: { shift: 50, invert: 10, retro: 0, trunc: 40, dim: 0, aug: 0 },
        jazz: { shift: 30, invert: 30, retro: 20, trunc: 10, dim: 10, aug: 0 },
        classical: { shift: 30, invert: 30, retro: 20, trunc: 0, dim: 10, aug: 10 },
        epic: { shift: 40, invert: 20, retro: 0, trunc: 0, dim: 10, aug: 30 },
        dark: { shift: 30, invert: 40, retro: 10, trunc: 0, dim: 0, aug: 20 },
        edm: { shift: 20, invert: 0, retro: 0, trunc: 40, dim: 40, aug: 0 },
        techno: { shift: 10, invert: 10, retro: 10, trunc: 30, dim: 40, aug: 0 },
        house: { shift: 40, invert: 10, retro: 0, trunc: 30, dim: 20, aug: 0 },
        lofi: { shift: 50, invert: 20, retro: 10, trunc: 20, dim: 0, aug: 0 },
        pop_punk: { shift: 70, invert: 10, retro: 0, trunc: 20, dim: 0, aug: 0 },
        jazz_bossa: { shift: 40, invert: 20, retro: 10, trunc: 20, dim: 10, aug: 0 }
    };

    // --- DAW FEATURE: Global Harmony Scanner ---
    function getGlobalActivePitchClasses(targetTime, activeDomain, targetTrackIdx) {
        let activePcs = new Set();

        const scanEngine = (engineObj, isLooper) => {
            if (!engineObj || !engineObj.tracks) return;
            engineObj.tracks.forEach((track, trackIdx) => {
                // Skip the track we are currently generating onto!
                if (isLooper === (activeDomain === 'looper') && trackIdx === targetTrackIdx) return;
                
                // THE FIX: Explicitly exclude 'drum', rather than exclusively requiring 'voice'.
                // This ensures piano, synth, and unassigned tracks are still scanned for harmony!
                const trackType = studio.trackTypes[isLooper ? trackIdx : trackIdx + 8];
                if (trackType === 'drum') return; 
                
                track.forEach(evt => {
                    if (evt.type === 'play' && evt.freqs) {
                        // Check if the event overlaps with our exact target time (with a tiny 10ms tolerance)
                        const start = evt.timeOffset - 0.01;
                        const end = evt.timeOffset + evt.duration + 0.01;
                        if (targetTime >= start && targetTime <= end) {
                            evt.freqs.forEach(f => {
                                if (isFinite(f)) {
                                    const midi = Math.round(12 * Math.log2(f / masterTune) + 69);
                                    activePcs.add(((midi % 12) + 12) % 12);
                                }
                            });
                        }
                    }
                });
            });
        };

        scanEngine(arranger, false);
        scanEngine(looper, true);

        return activePcs;
    }

    function generateAIProgression() {
        const mood = document.getElementById('genMood').value;
        const style = document.getElementById('genStyle').value;

        const valLeaps = parseInt(document.getElementById('genMelodicLeaps')?.value ?? 20);
        const valPassing = parseInt(document.getElementById('genPassingTones')?.value ?? 40);
        const valTimingHum = parseInt(document.getElementById('genTimingHum')?.value ?? 30) / 100;
        const valVelHum = parseInt(document.getElementById('genVelHum')?.value ?? 40) / 100;
        const valBorrowed = (parseInt(document.getElementById('genBorrowed')?.value ?? 15) / 100) * 0.4; // Caps the actual probability at 40%, even if the user slides it to 100%
        const valExtensions = parseInt(document.getElementById('genExtensions')?.value ?? 30) / 100;
        const valContour = parseInt(document.getElementById('genContour')?.value ?? 80) / 100;
        const valLegato = parseInt(document.getElementById('genLegato')?.value ?? 60) / 100;
        const valMotif = parseInt(document.getElementById('genMotif')?.value ?? 75) / 100;
        const valPhraseLength = parseInt(document.getElementById('genPhraseLength')?.value ?? 50) / 100;
        const valMelodicRange = parseInt(document.getElementById('genMelodicRange')?.value ?? 50) / 100;
        const valSwing = parseInt(document.getElementById('genSwing')?.value ?? 0) / 100;

        const startBar = parseInt(document.getElementById('genStartBar').value) - 1;
        const lengthBars = parseInt(document.getElementById('genLength').value);
        const beatSecs = 60 / currentArpBPM;
        const barSecs = beatSecs * beatsPerBar;
        const base16th = beatSecs / 4; 
        let currentTime = startBar * barSecs;
        let totalBarTicks = beatsPerBar * 4;

        const lib = progressionLibrary[mood];
        const romanBase = lib[Math.floor(Math.random() * lib.length)];
        let previousCenter = null; 
        
        let lastPlayedMelodyMidi = null;

        // ========================================================
        // 1. MACRO MOTIF GENERATOR (The "Composer" Brain)
        // ========================================================
        let defaultSlow = [[16], [8, 8], [12, 4], [4, 12], [8, 4, 4], [4, 4, 8], [6, 2, 8]]; 
        let defaultMed = [[4], [2, 2], [4, 4], [2, 2, 4], [4, 2, 2], [2, 4, 2], [3, 1, 4]]; 
        let defaultFast = [[1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [1, 2, 1], [2, 2]];

        if (mood === 'jazz_bossa' || mood === 'jazz') {
            defaultSlow = [[8, 8], [6, 2, 8], [8, 6, 2], [4, 12]];
            defaultMed = [[3, 3, 2], [2, 3, 3], [3, 1, 4], [2, 4, 2]]; 
            defaultFast = [[1, 2, 1], [2, 1, 1], [1, 1, 2], [3, 1]];
        } 
        else if (mood === 'house' || mood === 'techno' || mood === 'edm') {
            defaultSlow = [[16], [8, 8], [4, 4, 8]];
            defaultMed = [[2, 2, 2, 2], [3, 3, 2], [2, 2, 4], [4, 4]]; 
            defaultFast = [[1, 1, 1, 1], [1, 1, 2], [2, 2]];
        } 
        else if (mood === 'lofi' || mood === 'soul' || mood === 'rnb') {
            defaultSlow = [[16], [12, 4], [8, 8]];
            defaultMed = [[4, 4], [6, 2], [2, 6], [2, 4, 2]];
            defaultFast = [[2, 2], [2, 1, 1], [4]];
        }
        else if (mood === 'pop_punk') {
            defaultSlow = [[8, 8], [4, 4, 8]];
            defaultMed = [[2, 2, 2, 2], [4, 4], [2, 2, 4]];
            defaultFast = [[1, 1, 1, 1], [2, 2]];
        }

        let cellLibrary = style === 'melody_slow' ? defaultSlow : (style === 'melody_med' ? defaultMed : defaultFast);

        const primaryCell = cellLibrary[Math.floor(Math.random() * cellLibrary.length)];
        const secondaryCell = cellLibrary[Math.floor(Math.random() * cellLibrary.length)];
        const tertiaryCell = cellLibrary[Math.floor(Math.random() * cellLibrary.length)];

        const buildTheme = (cell, leaps, contourProb) => {
            let theme = [];
            let step = 0;
            let dir = Math.random() > 0.5 ? 1 : -1;
            let accumulatedTicks = 0;
            let i = 0;
            
            // Loop the rhythm cell until we have enough notes to fill an entire measure
            while (accumulatedTicks < totalBarTicks) {
                let noteLen = cell[i % cell.length];
                
                // Truncate the final note if it spills over the bar line
                if (accumulatedTicks + noteLen > totalBarTicks) {
                    noteLen = totalBarTicks - accumulatedTicks;
                }
                
                theme.push({ length: noteLen, step: step, isRest: false });
                accumulatedTicks += noteLen;

                if (Math.random() > contourProb) dir *= -1; 
                let jump = (Math.random() < (leaps / 100)) ? 2 : 1;
                step += (dir * jump);
                
                if (step > 4) dir = -1;
                if (step < -4) dir = 1;
                
                i++;
            }
            return theme;
        };

        const themeA = buildTheme(primaryCell, valLeaps, valContour);
        const themeB = buildTheme(secondaryCell, valLeaps, valContour);
        const themeC = buildTheme(tertiaryCell, valLeaps, valContour);

        // ========================================================
        // 2. BAR ITERATOR
        // ========================================================
        for (let b = 0; b < lengthBars; b++) {
            
            const barStartTime = currentTime;
            let midiArray = [];
            
            // --- TEMPORAL CONTEXT CHECK ---
            const activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
            const targetTrackIdx = activeDomain === 'looper' ? studio.activeLooperTrack : (studio.activeArrangerTrack - 8);
            const isContextAware = document.getElementById('genContextAware')?.checked;
            
            let existingChord = null;
            if (isContextAware) existingChord = getAggregatedChordForWindow(barStartTime, barSecs, activeDomain, targetTrackIdx);

            if (existingChord && existingChord.length > 0) {
                midiArray = existingChord;
                previousCenter = midiArray.reduce((a, b) => a + b, 0) / midiArray.length;
            } else {
                // --- THE DIATONIC HARMONY FIX (True Modal Stacking) ---
                const stepIndex = b % romanBase.length;
                let degree = romanBase[stepIndex];
                
                const mask = scaleMasks[currentScale] || scaleMasks['major'];
                
                // Build a 3-octave array of the active scale to stack thirds safely
                let fullScaleMidi = [];
                for (let oct = 3; oct <= 6; oct++) {
                    mask.forEach(interval => fullScaleMidi.push(currentKeyCenter + interval + (oct * 12)));
                }

                // Find the base root index inside our mapped scale
                let rootIdx = (degree - 1) % mask.length;
                while (fullScaleMidi[rootIdx] < 48) rootIdx += mask.length; // Anchor near C4

                // True Diatonic Stacking (Root, 3rd, 5th of the active mode)
                let rootMidi = fullScaleMidi[rootIdx];
                let thirdMidi = fullScaleMidi[rootIdx + 2];
                let fifthMidi = fullScaleMidi[rootIdx + 4];

                midiArray = [rootMidi, thirdMidi, fifthMidi];

                // Modal Borrowing (Override the 3rd to create parallel shifts)
                if (Math.random() < valBorrowed) {
                    let isMajor = (thirdMidi - rootMidi) === 4;
                    midiArray[1] += isMajor ? -1 : 1; // Swap Maj <-> Min
                }

                // Modal Extensions (Grabbing 7ths and 9ths natively from the scale)
                if (Math.random() < valExtensions) {
                    const addNinth = (valExtensions > 0.7) && (Math.random() < 0.5);
                    midiArray.push(fullScaleMidi[rootIdx + (addNinth ? 8 : 6)]); 
                }

                // Block Chord Voice Leading
                if (previousCenter !== null) {
                    let currentAvg = midiArray.reduce((a, b) => a + b, 0) / midiArray.length;
                    let bestDiff = Math.abs(currentAvg - previousCenter);
                    let bestShift = 0;
                    for (let oct = -2; oct <= 2; oct++) {
                        let testAvg = currentAvg + (oct * 12);
                        if (Math.abs(testAvg - previousCenter) < bestDiff) {
                            bestDiff = Math.abs(testAvg - previousCenter);
                            bestShift = oct * 12;
                        }
                    }
                    midiArray = midiArray.map(m => m + bestShift);
                    const currentCenter = previousCenter; 
                    midiArray = midiArray.map(m => {
                        if (m - currentCenter > 8) return m - 12; 
                        if (currentCenter - m > 8) return m + 12; 
                        return m;
                    });
                }
                previousCenter = midiArray.reduce((a, b) => a + b, 0) / midiArray.length;
                midiArray.sort((a, b) => a - b);
            }

            let targetFreqs = midiArray.map(midi => masterTune * Math.pow(2, (midi - 69) / 12));
            
            // --- DYNAMIC RATE DIVISOR ---
            let rateDivisor = 8;
            if (style.includes('_4') || style === 'melody_slow' || style === 'block_1') rateDivisor = 4;
            if (style.includes('_16') || style === 'arp_pattern1' || style === 'melody_fast') rateDivisor = 16;
            
            const stepDur = barSecs / rateDivisor;
            const steps = beatsPerBar * (rateDivisor / 4);

            let barNotes = []; 

            const bufferNote = (freqs, tOffset, dur, isMelody = false) => {
                const maxTimeShift = (base16th / 4) * valTimingHum; 
                const humanTime = Math.max(currentTime, tOffset + ((Math.random() - 0.5) * 2 * maxTimeShift));
                const humanVel = Math.floor(100 - (Math.random() * valVelHum * 40));
                barNotes.push({ timeOffset: humanTime, duration: dur, freqs: freqs, velocity: humanVel, isMelody: isMelody });
            };

            // ========================================================
            // RHYTHMIC CHORDS (BLOCKS)
            // ========================================================
            if (style.startsWith('block_')) {
                if (style === 'block_1') {
                    bufferNote(targetFreqs, currentTime, barSecs);
                } else if (style === 'block_4' || style === 'block_8') {
                    for (let i = 0; i < steps; i++) {
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        bufferNote(targetFreqs, currentTime + (i * stepDur) + swingDelay, stepDur * 0.85);
                    }
                } else if (style === 'block_offbeat_8') {
                    for (let i = 0; i < steps; i++) {
                        if (i % 2 !== 0) { // Only play the 'ANDs'
                            const swingDelay = (stepDur * valSwing * 0.6);
                            bufferNote(targetFreqs, currentTime + (i * stepDur) + swingDelay, stepDur * 0.8);
                        }
                    }
                } else if (style === 'block_sync_8') {
                    let syncPattern = [1, 0, 0, 1, 0, 0, 1, 0]; // 3-3-2 Clavé
                    for (let i = 0; i < steps; i++) {
                        if (syncPattern[i % 8]) {
                            const isOffbeatStep = i % 2 !== 0;
                            const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                            // Make syncopated notes punchy and slightly longer to bridge the gap
                            bufferNote(targetFreqs, currentTime + (i * stepDur) + swingDelay, stepDur * 1.5);
                        }
                    }
                }
            } 
            // ========================================================
            // BASS LINES
            // ========================================================
            else if (style.startsWith('bass_')) {
                // Drop the sorted root by exactly one octave to put it deep in the bass register
                let bassRootFreq = targetFreqs[0] / 2;
                let bassOctFreq = targetFreqs[0];
                let bassFifthFreq = (targetFreqs[2] || (targetFreqs[0] * 1.5)) / 2;
                
                if (style === 'bass_pedal_4' || style === 'bass_pedal_8') {
                    for (let i = 0; i < steps; i++) {
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        bufferNote([bassRootFreq], currentTime + (i * stepDur) + swingDelay, stepDur * 0.85);
                    }
                } else if (style.startsWith('bass_octaves_')) {
                    for (let i = 0; i < steps; i++) {
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        // Alternate between the deep root and the octave up
                        bufferNote([i % 2 === 0 ? bassRootFreq : bassOctFreq], currentTime + (i * stepDur) + swingDelay, stepDur * 0.8);
                    }
                } else if (style === 'bass_bossa_8') {
                    let bossaPat = [1, 0, 0, 1, 1, 0, 0, 1]; // Classic Latin dotted-quarter feel
                    for (let i = 0; i < steps; i++) {
                        if (bossaPat[i % 8]) {
                            const isOffbeatStep = i % 2 !== 0;
                            const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                            // Play Root on beat 1, Fifth on beat 3
                            let f = (i % 8 < 4) ? bassRootFreq : bassFifthFreq;
                            bufferNote([f], currentTime + (i * stepDur) + swingDelay, stepDur * 1.2);
                        }
                    }
                } else if (style === 'bass_walking_4') {
                    // For walking bass, we perfectly outline the chord tones we generated
                    for (let i = 0; i < steps; i++) {
                        let f = bassRootFreq;
                        if (i % 4 === 1 && targetFreqs[1]) f = targetFreqs[1] / 2; // 3rd
                        else if (i % 4 === 2 && targetFreqs[2]) f = targetFreqs[2] / 2; // 5th
                        else if (i % 4 === 3) f = (targetFreqs[2] || targetFreqs[0] * 1.5) / 2 * 1.05946; // Half-step passing tone
                        
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        bufferNote([f], currentTime + (i * stepDur) + swingDelay, stepDur * 0.95);
                    }
                }
            }
            // ========================================================
            // GUITAR & STRUMMING
            // ========================================================
            else if (style.startsWith('strum_')) {
                if (style === 'strum_folk_8') {
                    for (let i = 0; i < steps; i++) {
                        // Play just the bass root on downbeats, and the rest of the chord on upbeats
                        let strumFreqs = i % 2 === 0 ? [targetFreqs[0]] : targetFreqs.slice(1);
                        if (strumFreqs.length === 0) strumFreqs = [targetFreqs[0]]; // Fallback
                        
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        bufferNote(strumFreqs, currentTime + (i * stepDur) + swingDelay, stepDur * 0.85);
                    }
                } else {
                    let syncPattern = [1, 0, 1, 1, 0, 1, 1, 1]; 
                    for (let i = 0; i < steps; i++) {
                        if (style === 'strum_sync_8' && syncPattern[i % 8] === 0) continue; 
                        
                        const isDown = style === 'strum_down_4' || style === 'strum_fast_16' || (style.includes('updown') && i % 2 === 0) || (style === 'strum_sync_8' && [0, 2, 6].includes(i % 8));
                        let currentStrum = [...targetFreqs];
                        if (isDown) currentStrum.reverse();
                        
                        currentStrum.forEach((f, strIdx) => {
                            // Fast 16th strums sweep across the strings twice as fast!
                            const delay = strIdx * (style === 'strum_fast_16' ? 0.015 : 0.035); 
                            const isOffbeatStep = i % 2 !== 0;
                            const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                            bufferNote([f], currentTime + (i * stepDur) + delay + swingDelay, (stepDur * 0.9) - delay);
                        });
                    }
                }
            }
            // ========================================================
            // THE UPGRADED SOLO MELODY ENGINE
            // ========================================================
            else if (style.startsWith('melody_')) {
                
                // 1. THE MACRO FORM ENGINE
                if (b === 0 && !this.formArray) {
                    this.formArray = [];
                    
                    if (lengthBars === 1) {
                        this.formArray = ['A'];
                    } else if (lengthBars === 2) {
                        this.formArray = ['A', 'A_res']; 
                    } else if (lengthBars === 3) {
                        this.formArray = ['A', 'B', 'A_res'];
                    } else if (lengthBars === 4) {
                        if (mood === 'edm' || mood === 'techno' || mood === 'house') {
                            this.formArray = ['A', 'A', 'A_var', 'B']; // Build-up to Drop
                        } else if (mood === 'classical' || mood === 'epic') {
                            this.formArray = ['A', 'B', 'A_var', 'C']; // Sonata / Period Form
                        } else {
                            this.formArray = ['A', 'A_var', 'B', 'A_res']; // Standard Pop AABA
                        }
                    } else {
                        const barsPerPhrase = Math.floor(lengthBars / 4);
                        const remainder = lengthBars % 4;
                        
                        let baseForm = ['A', 'A_var', 'B', 'A_res'];
                        if (mood === 'edm' || mood === 'techno') baseForm = ['A', 'A', 'A_var', 'B'];
                        
                        for (let i = 0; i < 4; i++) {
                            for (let j = 0; j < barsPerPhrase; j++) {
                                if (j === barsPerPhrase - 1 && baseForm[i] === 'A') this.formArray.push('A_var');
                                else if (j === barsPerPhrase - 1 && baseForm[i] === 'B') this.formArray.push('B_var');
                                else this.formArray.push(baseForm[i]);
                            }
                        }
                        for (let i = 0; i < remainder; i++) this.formArray.push('A_res');
                    }
                }

                // Fetch the blueprint for the current bar
                const currentThemeMarker = this.formArray[b];
                let activeTheme = [];

                if (currentThemeMarker === 'A') {
                    activeTheme = JSON.parse(JSON.stringify(themeA)); 
                } 
                else if (currentThemeMarker === 'A_var' || currentThemeMarker === 'B_var') {
                    activeTheme = JSON.parse(JSON.stringify(currentThemeMarker === 'A_var' ? themeA : themeB)); 
                    
                    if (Math.random() > valMotif) {
                        // 1. Fetch the genre-specific weights
                        const weights = variationProfiles[mood] || variationProfiles['pop'];
                        
                        // 2. Select a variation based on those weights
                        let totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
                        let randomNum = Math.random() * totalWeight;
                        let selectedVar = 'shift';
                        
                        for (const [vType, weight] of Object.entries(weights)) {
                            if (randomNum < weight) { selectedVar = vType; break; }
                            randomNum -= weight;
                        }

                        // 3. Apply the chosen musical variation
                        if (selectedVar === 'shift') {
                            // Sequences: Shift up/down by 1 or 2 scale degrees
                            let shiftAmt = (Math.random() > 0.5 ? 1 : -1) * (Math.random() > 0.8 ? 2 : 1);
                            activeTheme.forEach(n => { if (n.step !== null) n.step += shiftAmt });
                        } 
                        else if (selectedVar === 'invert') {
                            activeTheme.forEach(n => { if (n.step !== null) n.step *= -1 });
                        } 
                        else if (selectedVar === 'retro') {
                            activeTheme.reverse();
                        } 
                        else if (selectedVar === 'trunc') {
                            // Cut the motif in half, replacing the rest with silence
                            let halfLength = Math.ceil(activeTheme.length / 2);
                            let truncatedTime = 0;
                            for (let i = halfLength; i < activeTheme.length; i++) {
                                truncatedTime += activeTheme[i].length;
                            }
                            activeTheme = activeTheme.slice(0, halfLength);
                            activeTheme.push({ length: truncatedTime, step: null, isRest: true });
                        }
                        else if (selectedVar === 'dim') {
                            // Play twice as fast, then rest for the remainder
                            let totalTime = 0;
                            activeTheme.forEach(n => { 
                                totalTime += n.length; 
                                n.length /= 2; 
                            });
                            activeTheme.push({ length: totalTime / 2, step: null, isRest: true });
                        }
                        else if (selectedVar === 'aug') {
                            // Play half as fast (we only take the first half of the notes so it fits the bar)
                            let halfLength = Math.ceil(activeTheme.length / 2);
                            activeTheme = activeTheme.slice(0, halfLength);
                            activeTheme.forEach(n => { n.length *= 2; });
                        }
                    }
                }
                else if (currentThemeMarker === 'B') {
                    activeTheme = JSON.parse(JSON.stringify(themeB)); 
                } 
                else if (currentThemeMarker === 'C') {
                    activeTheme = JSON.parse(JSON.stringify(themeC)); 
                }
                else { // Fallback (used for 'A_res')
                    activeTheme = JSON.parse(JSON.stringify(themeA)); 
                }

                // 2. Phrasing / Breathing
                let baseRatio = 0.3 + (valPhraseLength * 0.7); 
                let activeRatio = baseRatio + ((Math.random() * 0.3) - 0.15); 
                
                if (valPhraseLength === 1.0) {
                    activeRatio = 1.0;
                } else {
                    activeRatio = Math.max(0.2, Math.min(1.0, activeRatio)); 
                }
                
                let activeTicks = totalBarTicks * activeRatio; 
                let currentTicks = 0;
                
                for (let i = 0; i < activeTheme.length; i++) {
                    currentTicks += activeTheme[i].length;
                    
                    if (currentTicks >= activeTicks) {
                        const isResolutionBar = (b === lengthBars - 1) || currentThemeMarker.includes('res') || currentThemeMarker === 'C';
                        
                        if (isResolutionBar) {
                            // Safe math: Prevents negative stretching if it slightly overshoots
                            activeTheme[i].length += Math.max(0, totalBarTicks - currentTicks);
                        } else {
                            activeTheme[i].isRest = Math.random() > 0.4;
                        }
                        activeTheme = activeTheme.slice(0, i + 1);
                        break;
                    }
                }

                // 3. THE CHORD-SCALE FIX (Jazz Secret)
                let chordMidis = targetFreqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69)).sort((a, b) => a - b);
                const mask = scaleMasks[currentScale] || scaleMasks['all'];
                
                // Build a set of scale notes, but dynamically force the current chord's notes into it
                // so the melody flawlessly outlines borrowed chords!
                const activeScalePCs = new Set(mask.map(interval => (currentKeyCenter + interval) % 12));
                chordMidis.forEach(cm => activeScalePCs.add(cm % 12));
                
                let scaleArray = [];
                for (let i = 36; i <= 108; i++) {
                    if (activeScalePCs.has(((i % 12) + 12) % 12)) scaleArray.push(i);
                }

                // 4. THE MELODIC VOICE LEADING FIX (With Pendulum Gravity!)
                let anchorMidi;
                
                // Calculate the true center of gravity based on the UI slider
                let baselineTarget = 60 + (valMelodicRange * 24); // Maps 0-100% to C4-C6
                
                if (b === 0 || !lastPlayedMelodyMidi) {
                    // Start of generation: Anchor to the root + requested octave range
                    anchorMidi = chordMidis[0] + 12; 
                    while (anchorMidi < baselineTarget - 6) anchorMidi += 12;
                    while (anchorMidi > baselineTarget + 6) anchorMidi -= 12;
                } else {
                    // Consecutive Bars: Anchor to the chord tone NEAREST to the last note played!
                    let nearest = chordMidis[0] + 12;
                    let minDiff = 999;
                    chordMidis.forEach(cm => {
                        let pc = cm % 12;
                        let target1 = pc + Math.floor(lastPlayedMelodyMidi / 12) * 12;
                        [target1, target1 + 12, target1 - 12].forEach(targetMidi => {
                            if (Math.abs(targetMidi - lastPlayedMelodyMidi) < minDiff) { 
                                minDiff = Math.abs(targetMidi - lastPlayedMelodyMidi); 
                                nearest = targetMidi; 
                            }
                        });
                    });
                    anchorMidi = nearest;

                    // THE PENDULUM FIX: Enforce the boundaries!
                    // If the voice-leading dragged us more than a 5th (7 semitones) away 
                    // from our requested center, mathematically force the soloist to jump back home!
                    if (anchorMidi < baselineTarget - 8) anchorMidi += 12;
                    if (anchorMidi > baselineTarget + 8) anchorMidi -= 12;
                }

                // Map the calculated MIDI anchor to our allowed Scale Array
                let anchorIdx = scaleArray.indexOf(anchorMidi);
                if (anchorIdx === -1) {
                    let minD = 999;
                    scaleArray.forEach((m, idx) => {
                        if (Math.abs(m - anchorMidi) < minD) { minD = Math.abs(m - anchorMidi); anchorIdx = idx; }
                    });
                }

                // 5. Render the Motif into Notes
                let t = currentTime;
                let remainingTicks = totalBarTicks;

                activeTheme.forEach(noteData => {
                    if (remainingTicks <= 0) return; 

                    let ticksToPlay = Math.min(noteData.length, remainingTicks);
                    let noteDur = ticksToPlay * base16th;

                    if (!noteData.isRest) {
                        let noteIdx = anchorIdx + noteData.step;
                        noteIdx = Math.max(0, Math.min(scaleArray.length - 1, noteIdx));
                        let nextMidi = scaleArray[noteIdx];

                        // Dissonance Check
                        let isChordTone = chordMidis.some(cm => (cm % 12) === (nextMidi % 12));
                        if (!isChordTone && ticksToPlay >= 4) {
                            let nearest = nextMidi;
                            let minDiff = 999;
                            chordMidis.forEach(cm => {
                                let pc = cm % 12;
                                let target1 = pc + Math.floor(nextMidi / 12) * 12;
                                [target1, target1 + 12, target1 - 12].forEach(targetMidi => {
                                    if (Math.abs(targetMidi - nextMidi) < minDiff) { 
                                        minDiff = Math.abs(targetMidi - nextMidi); 
                                        nearest = targetMidi; 
                                    }
                                });
                            });
                            nextMidi = nearest;
                        }

                        const beatPos = (t - currentTime) / base16th;
                        const isOffbeat = (Math.abs(beatPos % 2) > 0.01);
                        if (isOffbeat && !isChordTone && ticksToPlay < 4 && Math.random() < (valPassing / 100)) {
                            nextMidi += (Math.random() > 0.5 ? 1 : -1);
                        }

                        lastPlayedMelodyMidi = nextMidi; 

                        const swingDelay = isOffbeat ? (base16th * valSwing * 0.6) : 0;

                        const freq = masterTune * Math.pow(2, (nextMidi - 69) / 12);
                        bufferNote([freq], t + swingDelay, noteDur * 0.96, true);
                    }

                    t += noteDur;
                    remainingTicks -= ticksToPlay;
                });
            }

            // ========================================================
            // ARPEGGIATORS
            // ========================================================
            else if (style.startsWith('arp_') || style === 'travis') {
                let sortedFreqs = [...targetFreqs];
                let pattern = [];
                
                if (style.includes('arp_up')) {
                    for (let i = 0; i < steps; i++) pattern.push(sortedFreqs[i % sortedFreqs.length]);
                } else if (style.includes('arp_down')) {
                    let rev = [...sortedFreqs].reverse();
                    for (let i = 0; i < steps; i++) pattern.push(rev[i % rev.length]);
                } else if (style.includes('arp_updown')) {
                    let ud = [...sortedFreqs];
                    for (let i = sortedFreqs.length - 2; i > 0; i--) ud.push(sortedFreqs[i]);
                    for (let i = 0; i < steps; i++) pattern.push(ud[i % ud.length]);
                } else if (style === 'arp_pattern1') {
                    const root = sortedFreqs[0];
                    for (let i = 0; i < steps; i++) {
                        const upIndex = Math.floor(i / 2) + 1;
                        pattern.push(i % 2 === 0 ? root : sortedFreqs[upIndex % sortedFreqs.length]);
                    }
                } else if (style === 'arp_euclid') {
                    for (let i = 0; i < steps; i++) {
                        if (i % 8 === 0 || i % 8 === 3 || i % 8 === 6) pattern.push(sortedFreqs[Math.floor(Math.random() * sortedFreqs.length)]);
                        else pattern.push(null);
                    }
                } else if (style.includes('arp_random')) {
                    for (let i = 0; i < steps; i++) pattern.push(sortedFreqs[Math.floor(Math.random() * sortedFreqs.length)]);
                } else if (style === 'arp_alberti_8') {
                    // Classic Classical Left-Hand Piano: Low, High, Mid, High
                    const low = sortedFreqs[0];
                    const mid = sortedFreqs[1] || sortedFreqs[0];
                    const high = sortedFreqs[2] || sortedFreqs[1] || sortedFreqs[0];
                    const albertiSeq = [low, high, mid, high];
                    for (let i = 0; i < steps; i++) pattern.push(albertiSeq[i % albertiSeq.length]);
                } else if (style === 'travis') {
                    const root = sortedFreqs[0];
                    const high = sortedFreqs[sortedFreqs.length - 1];
                    const mid = sortedFreqs[1] || root;
                    const travSeq = [root, high, mid, high];
                    for (let i = 0; i < steps; i++) pattern.push(travSeq[i % travSeq.length]);
                }
                
                pattern.forEach((f, i) => {
                    if (f !== null && isFinite(f)) {
                        // THE SWING FIX (For Arpeggios)
                        const isOffbeatStep = i % 2 !== 0;
                        const swingDelay = isOffbeatStep ? (stepDur * valSwing * 0.6) : 0;
                        bufferNote([f], currentTime + (i * stepDur) + swingDelay, stepDur * 0.85); 
                    }
                });
            }

            if (barNotes.length > 0) {
                barNotes.sort((a, b) => a.timeOffset - b.timeOffset);
                let mergedBuffer = [];
                let currentNote = barNotes[0];

                const mergeChance = valLegato; 

                for (let i = 1; i < barNotes.length; i++) {
                    let nextNote = barNotes[i];
                    const isSamePitch = currentNote.freqs.length === nextNote.freqs.length && 
                        currentNote.freqs.every((f, idx) => Math.abs(f - nextNote.freqs[idx]) < 0.1);
                    const gap = nextNote.timeOffset - (currentNote.timeOffset + currentNote.duration);
                    
                    if (isSamePitch && gap < 0.06 && Math.random() < mergeChance && !currentNote.isMelody && !style.startsWith('strum_')) {
                        currentNote.duration = (nextNote.timeOffset + nextNote.duration) - currentNote.timeOffset;
                    } else {
                        mergedBuffer.push(currentNote);
                        currentNote = nextNote;
                    }
                }
                mergedBuffer.push(currentNote);

                mergedBuffer.forEach(n => {
                    handleStepEntry(n.freqs, null, null, n.velocity, n.timeOffset, n.duration);
                });
            }

            currentTime += barSecs;
        }

        const startBarInput = document.getElementById('genStartBar');
        if (startBarInput) startBarInput.value = parseInt(startBarInput.value) + lengthBars;

        if (typeof drawPianoRoll === 'function') drawPianoRoll();
        showToast(`Generated ${lengthBars} bars of ${mood} harmony!`);

        this.formArray = null; // Clear the memory blueprint for the next run
    }

    // Wire up the Generator Execute button
    document.getElementById('btnExecuteGen')?.addEventListener('click', generateAIProgression);

    // --- PIANO KEYBOARD SCALE HIGHLIGHTER ---
    function updatePianoScaleHighlights() {
        const keys = document.querySelectorAll('.piano-key');
        if (!keys.length) return;

        // 1. Bail out and clear all dots if chromatic/all notes is selected
        if (!currentScale || currentScale === 'all' || currentScale === 'chromatic') {
            keys.forEach(key => key.classList.remove('in-scale', 'is-root'));
            return;
        }

        const mask = scaleMasks[currentScale];
        if (!mask) return;

        // 2. Calculate the active pitch classes (0-11) for the current key center
        const activeScalePCs = new Set(mask.map(interval => (currentKeyCenter + interval) % 12));
        const rootPC = ((currentKeyCenter % 12) + 12) % 12;

        // 3. Apply classes to the physical DOM keys
        keys.forEach(key => {
            const midiNote = parseInt(key.dataset.note);
            if (isNaN(midiNote)) return;

            const pc = ((midiNote % 12) + 12) % 12;

            if (activeScalePCs.has(pc)) {
                key.classList.add('in-scale');
                if (pc === rootPC) {
                    key.classList.add('is-root');
                } else {
                    key.classList.remove('is-root');
                }
            } else {
                key.classList.remove('in-scale', 'is-root');
            }
        });
    }

    // =====================================================================
    // PIANO ROLL EDITOR ENGINE
    // =====================================================================
    const prCanvas = document.getElementById('pr-canvas');
    let prCtx = null;
    if (prCanvas) prCtx = prCanvas.getContext('2d');

    const velCanvas = document.getElementById('pr-vel-canvas');
    let velCtx = null;
    if (velCanvas) velCtx = velCanvas.getContext('2d');

    let prScrollTime = 0; // The time offset at the bottom of the screen
    let prZoomY = 80;     // Pixels per second (Vertical Zoom)
    let isPrAutoScroll = true;
    let currentPrTool = 'select'; // 'select', 'draw', or 'erase'
    let prSnapRes = 0.25;         // Default 1/16th note snap

    // --- STEP ENTRY ENGINE STATE ---
    let isStepEntryMode = false;
    let stepCursorTime = 0;

    // The exact 16 colors mapping to L1-L8 and A1-A8
    const trackColors = [
        '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4',
        '#009688', '#4caf50', '#8bc34a', '#cddc39', '#ffeb3b', '#ffc107', '#ff9800', '#ff5722'
    ];

    // MATHEMATICAL MAGIC: Uniform grid spacing for perfect editing
    function getNoteXAndWidth(midiNote, canvasWidth) {
        if (currentPianoMin === null || currentPianoMax === null) return { x: 0, w: 0 };

        // 1. Calculate how many total semitones are visible on screen
        const totalVisibleNotes = (currentPianoMax - currentPianoMin) + 1;
        if (totalVisibleNotes <= 0) return { x: 0, w: 0 };

        // 2. Divide the canvas evenly. Every note gets the exact same width!
        const noteW = canvasWidth / totalVisibleNotes;
        const x = (midiNote - currentPianoMin) * noteW;

        // 3. We still check if it's black or white just so the background 
        //    stripes can be colored correctly in the draw loop
        const whiteKeys = [0, 2, 4, 5, 7, 9, 11];
        const isBlack = !whiteKeys.includes(midiNote % 12);

        return { x: x, w: noteW, isBlack: isBlack };
    }

    function drawPianoRoll() {
        if (!prCanvas || !prCtx || !isPianoRollActive) return;

        // --- Render Culling Optimization ---
        // If the panel is collapsed to just the toolbar (<= 45px), abort drawing entirely!
        const overlay = document.getElementById('piano-roll-overlay');
        if (overlay && overlay.offsetHeight <= 45) {
            return; 
        }

        // 1. High-DPI Canvas Scaling
        const dpr = window.devicePixelRatio || 1;
        
        // Scale Main Piano Roll Canvas
        const rect = prCanvas.parentElement.getBoundingClientRect();
        if (prCanvas.width !== Math.floor(rect.width * dpr) || prCanvas.height !== Math.floor(rect.height * dpr)) {
            prCanvas.width = Math.floor(rect.width * dpr);
            prCanvas.height = Math.floor(rect.height * dpr);
            prCtx.scale(dpr, dpr);
        }

        // --- THE FIX: Scale Velocity Canvas using the exact same math! ---
        if (typeof velCanvas !== 'undefined' && velCanvas && velCanvas.parentElement) {
            const velRect = velCanvas.parentElement.getBoundingClientRect();
            if (velCanvas.width !== Math.floor(velRect.width * dpr) || velCanvas.height !== Math.floor(velRect.height * dpr)) {
                velCanvas.width = Math.floor(velRect.width * dpr);
                velCanvas.height = Math.floor(velRect.height * dpr);
                velCanvas.getContext('2d')?.scale(dpr, dpr);
            }
        }

        const w = rect.width;
        const h = rect.height;

        // 2. Clear Background
        prCtx.fillStyle = '#1a1a1a';
        prCtx.fillRect(0, 0, w, h);

        // --- DRAW LOOPER BOUNDARY VOID ---
        let activeDomain = studio.lastSelectedDomain;
        let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        const isDrumTrack = studio.trackTypes[activeIdx] === 'drum'; // <-- WE ADD THIS CHECK!

        if (activeDomain === 'looper') {
            const beatSecs = 60 / currentArpBPM;
            const lenEl = document.getElementById('looperLength');
            const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * beatSecs;
            const loopSec = looper.trackDurations[activeIdx] || globalLoopSec;

            // Calculate the Y-pixel where the loop ends
            const loopEndY = h - ((loopSec - prScrollTime) * prZoomY);

            // If the end of the loop is currently visible on screen, draw a dark overlay above it!
            if (loopEndY > 0) {
                prCtx.fillStyle = 'rgba(0, 0, 0, 0.7)'; // Heavy dark shading
                prCtx.fillRect(0, 0, w, loopEndY);

                // Draw a bright red boundary line
                prCtx.strokeStyle = '#f44336';
                prCtx.lineWidth = 2;
                prCtx.beginPath();
                prCtx.moveTo(0, loopEndY);
                prCtx.lineTo(w, loopEndY);
                prCtx.stroke();
            }
        }

        // --- PRE-CALCULATE GLOBAL LABEL THRESHOLD ---
        // We evaluate the absolute worst-case scenario to create an 
        // ALL-OR-NOTHING toggle for the top row of labels!
        prCtx.font = `bold 10px sans-serif`;
        const maxTextWidth = prCtx.measureText("ACOUSTIC BASS DRUM").width;
        const showTopLabels = h > (maxTextWidth * 2) + 45;

        // 3. Draw Piano Key Lanes (Background Stripes)
        const whiteKeys = [0, 2, 4, 5, 7, 9, 11];
        for (let note = currentPianoMin; note <= currentPianoMax; note++) {
            const { x, w: noteW, isBlack } = getNoteXAndWidth(note, w);
            
            if (isBlack) {
                prCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                prCtx.fillRect(x, 0, noteW, h);
            } else {
                prCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
                prCtx.lineWidth = 1;
                prCtx.beginPath();
                prCtx.moveTo(x, 0);
                prCtx.lineTo(x, h);
                prCtx.stroke();
            }

            if (isDrumTrack) {
                // --- NEW: VERTICAL DRUM LABELS (GM STANDARD) ---
                if (gmDrumMap[note]) {
                    const drumName = gmDrumMap[note].name.toUpperCase(); 
                    
                    prCtx.fillStyle = 'rgba(255, 255, 255, 0.04)';
                    prCtx.fillRect(x, 0, noteW, h);

                    prCtx.fillStyle = 'rgba(255, 255, 255, 0.45)'; 
                    prCtx.font = `bold 10px sans-serif`;

                    // Bottom Label (Always visible)
                    prCtx.save();
                    prCtx.textAlign = 'left';
                    prCtx.textBaseline = 'middle';
                    prCtx.translate(x + (noteW / 2), h - 10);
                    prCtx.rotate(-Math.PI / 2);
                    prCtx.fillText(drumName, 0, 0);
                    prCtx.restore();
                    
                    // Top Label (Uses the GLOBAL toggle so it's perfectly uniform)
                    if (showTopLabels) {
                        prCtx.save();
                        prCtx.textAlign = 'right';
                        prCtx.textBaseline = 'middle';
                        prCtx.translate(x + (noteW / 2), 15);
                        prCtx.rotate(-Math.PI / 2);
                        prCtx.fillText(drumName, 0, 0);
                        prCtx.restore();
                    }
                }
            } else {
                // --- EXISTING: PIANO OCTAVE MARKERS ---
                if (note % 12 === 0) {
                    const octave = Math.floor(note / 12) - 1; 
                    const labelText = `C${octave}`;
                    
                    prCtx.fillStyle = 'rgba(255, 255, 255, 0.3)'; 
                    prCtx.font = `bold 10px sans-serif`; 
                    prCtx.textAlign = 'center';
                    
                    // Bottom Marker (Always visible)
                    prCtx.fillText(labelText, x + (noteW / 2), h - 10); 

                    // Top Marker (Uses the GLOBAL toggle)
                    if (showTopLabels) {
                        prCtx.fillText(labelText, x + (noteW / 2), 15); 
                    }
                }
            }
        }

        // 4. Draw Beat/Bar Lines (Horizontal)
        const beatSecs = 60 / currentArpBPM;
        const screenTimeSecs = h / prZoomY;
        const startTime = prScrollTime;
        const endTime = prScrollTime + screenTimeSecs;

        let currentBeat = Math.floor(startTime / beatSecs);
        let currentBeatTime = currentBeat * beatSecs;

        while (currentBeatTime <= endTime) {
            if (currentBeatTime >= startTime) {
                const y = h - ((currentBeatTime - prScrollTime) * prZoomY);
                const isBar = currentBeat % beatsPerBar === 0;

                prCtx.strokeStyle = isBar ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)';
                prCtx.lineWidth = isBar ? 2 : 1;
                prCtx.beginPath();
                prCtx.moveTo(0, y);
                prCtx.lineTo(w, y);
                prCtx.stroke();

                // --- NEW: BAR NUMBERS (Left Edge Ruler) ---
                if (isBar) {
                    const barNumber = Math.floor(currentBeat / beatsPerBar) + 1;
                    prCtx.fillStyle = 'rgba(0, 0, 0, 0.65)';
                    prCtx.fillRect(0, y - 16, 40, 16); // Removed * dpr
                    
                    prCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    prCtx.font = `bold 10px sans-serif`; // Removed * dpr
                    prCtx.textAlign = 'left';
                    prCtx.fillText(`Bar ${barNumber}`, 4, y - 4); // Removed * dpr
                }
            }
            currentBeat++;
            currentBeatTime += beatSecs;
        }

        // 4.5 Draw Looper Regions (Arrangement Mode)
        if (activeDomain === 'looper' && looper.regions[activeIdx]) {
            looper.regions[activeIdx].forEach(region => {
                const yBottom = h - ((region.start - prScrollTime) * prZoomY);
                const yTop = h - ((region.end - prScrollTime) * prZoomY);
                const regionH = Math.max(2, yBottom - yTop);

                if (yBottom > 0 && yTop < h) {
                    prCtx.fillStyle = 'rgba(156, 39, 176, 0.25)'; // Transparent Purple
                    prCtx.fillRect(0, yTop, w, regionH);
                    
                    prCtx.strokeStyle = '#9c27b0'; // Solid Purple Border
                    prCtx.lineWidth = 2;
                    prCtx.strokeRect(0, yTop, w, regionH);
                    
                    prCtx.fillStyle = '#9c27b0';
                    prCtx.font = `bold ${12 * dpr}px sans-serif`;
                    prCtx.fillText('⬛ ACTIVE REGION', 10, yTop + 15 * dpr);
                }
            });
        }

        // 5. Draw the Notes!
        const drawTrackNotes =(trackEvents, trackIdx, isActiveTrack) => {
            const color = trackColors[trackIdx];

            trackEvents.forEach(evt => {
                const isSelected = typeof prSelectedNotes !== 'undefined' && prSelectedNotes.has(evt);
                
                const yBottom = h - ((evt.timeOffset - prScrollTime) * prZoomY);
                const yTop = h - (((evt.timeOffset + (evt.duration || 0.5)) - prScrollTime) * prZoomY);
                const noteH = yBottom - yTop;

                if (yBottom < 0 || yTop > h) return;

                // --- RENDER AUDIO STEMS WITH WAVEFORMS ---
                if (evt.type === 'stem') {
                    // 1. Draw the container box
                    prCtx.fillStyle = isSelected ? 'rgba(255, 235, 59, 0.15)' : color + '22';
                    prCtx.strokeStyle = isSelected ? '#ffeb3b' : color;
                    prCtx.lineWidth = 2;
                    prCtx.fillRect(0, yTop, w, noteH);
                    prCtx.strokeRect(0, yTop, w, noteH);

                    // 2. Draw the Waveform (if peaks exist)
                    if (evt.peaks) {
                        // THE FIX: Clamp the max width so it doesn't look ridiculous on big screens
                        const maxWaveW = Math.min(w * 0.85, 160 * dpr); 
                        const centerX = w / 2;
                        const numPeaks = evt.peaks.length;
                        const sliceH = noteH / numPeaks;

                        prCtx.fillStyle = isSelected ? 'rgba(255, 235, 59, 0.7)' : color + 'aa';
                        prCtx.beginPath();

                        // Draw UP the right side of the waveform
                        prCtx.moveTo(centerX, yBottom);
                        for (let i = 0; i < numPeaks; i++) {
                            const y = yBottom - (i * sliceH); // Time goes UP
                            const ampX = (evt.peaks[i] * maxWaveW) / 2;
                            prCtx.lineTo(centerX + ampX, y);
                        }
                        
                        // Draw DOWN the left side of the waveform
                        for (let i = numPeaks - 1; i >= 0; i--) {
                            const y = yBottom - (i * sliceH);
                            const ampX = (evt.peaks[i] * maxWaveW) / 2;
                            prCtx.lineTo(centerX - ampX, y);
                        }
                        
                        prCtx.closePath();
                        prCtx.fill();
                    }

                    // 3. Draw the Label (ACTIVE TRACK ONLY)
                    if (isActiveTrack) {
                        prCtx.fillStyle = isSelected ? '#ffeb3b' : '#ffffff';
                        prCtx.font = `bold 11px sans-serif`;
                        
                        // Compile our text string
                        const clipName = evt.name ? evt.name : 'AUDIO STEM';
                        let extraInfo = [];
                        
                        // Add Channel Count
                        if (evt.buffer) {
                            extraInfo.push(evt.buffer.numberOfChannels === 2 ? 'Stereo' : 'Mono');
                        }
                        // Add Warp Status
                        if (evt.stretchRatio && evt.stretchRatio !== 1.0) {
                            extraInfo.push(`Warp: ${Math.round(evt.stretchRatio * 100)}%`);
                        }
                        
                        const labelText = extraInfo.length > 0 
                            ? `${clipName} [${extraInfo.join(' | ')}]` 
                            : clipName;

                        // Draw at the Bottom (Start of the clip)
                        prCtx.fillText(labelText, 10, yBottom - 10);

                        // MATH: Calculate if duration is >= 4 bars
                        const beatSecs = 60 / currentArpBPM;
                        const barSecs = beatSecs * beatsPerBar;
                        
                        if (evt.duration >= 4 * barSecs) {
                            // Draw at the Top (End of the clip)
                            // We push it down by 20px so it sits inside the upper bound
                            prCtx.fillText(labelText, 10, yTop + 20);
                        }
                    }
                    
                    return; // Skip standard MIDI rendering
                }

                prCtx.fillStyle = isSelected ? '#ffffff' : (isActiveTrack ? color : color + '40');
                prCtx.strokeStyle = isSelected ? '#ffeb3b' : (isActiveTrack ? '#ffffff' : 'transparent');
                prCtx.lineWidth = isSelected ? 2 : 1.5;

                let midiNotes = [];
                if (evt.type === 'play' && evt.freqs) {
                    midiNotes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                } else if (evt.type === 'drum' && evt.drumType) {
                    const drumMap = { 'kick': 36, 'snare': 38, 'hihat': 42, 'clap': 39, 'cymbal': 49, 'tom1': 45, 'tom2': 47, 'tom3': 43, 'cowbell': 56, 'ride': 51, 'rimshot': 37, 'click': 76 };
                    midiNotes = [drumMap[evt.drumType] || 36];
                }

                midiNotes.forEach(note => {
                    const { x, w: noteW } = getNoteXAndWidth(note, w);
                    if (noteW > 0) {
                        prCtx.fillRect(x + 1, yTop, noteW - 2, noteH);
                        if (isActiveTrack || isSelected) prCtx.strokeRect(x + 1, yTop, noteW - 2, noteH);
                    }
                });
            });
        };

        // Draw Looper Tracks (0-7)
        looper.tracks.forEach((track, idx) => {
            const isFocus = activeDomain === 'looper' && activeIdx === idx;
            drawTrackNotes(track, idx, isFocus);
        });

        // Draw Arranger Tracks (8-15)
        arranger.tracks.forEach((track, localIdx) => {
            const isFocus = activeDomain === 'arranger' && activeIdx === (localIdx + 8);
            drawTrackNotes(track, localIdx + 8, isFocus);
        });

        // --- DRAW GROUP RESIZE BOUNDING BOX ---
        if (prSelectedNotes.size > 1) {
            const bounds = getSelectionBounds();
            if (bounds) {
                const yBottom = h - ((bounds.minT - prScrollTime) * prZoomY);
                const yTop = h - ((bounds.maxT - prScrollTime) * prZoomY);
                
                const startXInfo = getNoteXAndWidth(bounds.minN, w);
                const endXInfo = getNoteXAndWidth(bounds.maxN, w);
                
                const boxX = startXInfo.x - 4;
                const boxW = (endXInfo.x + endXInfo.w) - boxX + 8;
                const boxH = Math.max(2, yBottom - yTop);

                // Ensure it's somewhat visible on screen
                if (yBottom > 0 && yTop < h) {
                    // Draw dashed border
                    prCtx.strokeStyle = '#00d2ff';
                    prCtx.lineWidth = 1;
                    prCtx.setLineDash([4, 4]);
                    prCtx.strokeRect(boxX, yTop, boxW, boxH);
                    prCtx.setLineDash([]);

                    // --- THE FIX: Only draw handles if the Select Tool is active ---
                    if (currentPrTool === 'select') {
                        prCtx.fillStyle = '#00d2ff';
                        const handleW = Math.min(boxW, 40 * dpr); // Max 40px wide
                        prCtx.fillRect(boxX + (boxW / 2) - (handleW / 2), yTop - (4 * dpr), handleW, 8 * dpr); // Top
                        prCtx.fillRect(boxX + (boxW / 2) - (handleW / 2), yBottom - (4 * dpr), handleW, 8 * dpr); // Bottom
                    }
                }
            }
        }

        // 6. Draw Playhead & Handle Auto-Scroll
        let playheadTime = null;
        let isPlayingOrRecording = false;

        if (activeDomain === 'looper' && (looper.isPlaying || looper.isRecording)) {
            const loopSec = looper.trackDurations[activeIdx] || ((parseInt(document.getElementById('looperLength')?.value) || 4) * 4 * beatSecs);
            let phase = (audioCtx.currentTime - looper.startTime) % loopSec;
            if (phase < 0) phase += loopSec;
            playheadTime = phase;
            isPlayingOrRecording = true;
        } else if (activeDomain === 'arranger' && (arranger.isPlaying || arranger.isRecording)) {
            playheadTime = audioCtx.currentTime - arranger.startTime;
            isPlayingOrRecording = true;
        } else if (activeDomain === 'arranger' && !arranger.isPlaying) {
            playheadTime = arranger.pauseTime;
        }

        if (playheadTime !== null) {
            // --- AUTO-SCROLL CAMERA MATH ---
            if (isPrAutoScroll) {
                // Keep the playhead locked exactly 25% from the bottom of the screen
                const screenTimeSecs = h / prZoomY;
                const targetScroll = playheadTime - (screenTimeSecs * 0.25);

                // Only snap the camera if we are within bounds (prevents negative scrolling)
                // If in Looper mode and it loops back to 0, the camera will instantly jump back!
                prScrollTime = Math.max(0, targetScroll);
            }

            // Draw the red line
            if (playheadTime >= prScrollTime && playheadTime <= prScrollTime + screenTimeSecs) {
                const playheadY = h - ((playheadTime - prScrollTime) * prZoomY);
                prCtx.strokeStyle = '#f44336';
                prCtx.lineWidth = 3;
                prCtx.beginPath();
                prCtx.moveTo(0, playheadY);
                prCtx.lineTo(w, playheadY);
                prCtx.stroke();
            }
        }

        // 7. DRAW STEP ENTRY CURSOR
        if (isStepEntryMode) {
            const stepY = h - ((stepCursorTime - prScrollTime) * prZoomY);
            if (stepY >= 0 && stepY <= h) {
                prCtx.strokeStyle = '#00d2ff'; // Bright Cyber Blue
                prCtx.lineWidth = 3;
                prCtx.beginPath();
                prCtx.moveTo(0, stepY);
                prCtx.lineTo(w, stepY);
                prCtx.stroke();
                prCtx.fillText('▶', 5, stepY - (5 * dpr));
            }
        }

        // 8. Draw Marquee Selection Box
        if (typeof prDragState !== 'undefined' && prDragState.isMarquee) {
            const startY = h - ((prDragState.marqueeStart.time - prScrollTime) * prZoomY);
            const currY = h - ((prDragState.marqueeCurrent.time - prScrollTime) * prZoomY);

            const startXInfo = getNoteXAndWidth(prDragState.marqueeStart.note, w);
            const currXInfo = getNoteXAndWidth(prDragState.marqueeCurrent.note, w);

            // Allow dragging the box in any direction
            const boxX = Math.min(startXInfo.x, currXInfo.x);
            const boxY = Math.min(startY, currY);
            const boxW = Math.abs(currXInfo.x - startXInfo.x) + currXInfo.w;
            const boxH = Math.abs(currY - startY);

            if (prDragState.tool === 'erase') {
                prCtx.fillStyle = 'rgba(244, 67, 54, 0.2)'; // Transparent RED for deletion
                prCtx.strokeStyle = '#f44336';
            } else {
                prCtx.fillStyle = 'rgba(33, 150, 243, 0.2)'; // Transparent BLUE for selection
                prCtx.strokeStyle = '#2196f3';
            }
            prCtx.lineWidth = 1;
            prCtx.setLineDash([5, 5]); // Dashed border
            prCtx.fillRect(boxX, boxY, boxW, boxH);
            prCtx.strokeRect(boxX, boxY, boxW, boxH);
            prCtx.setLineDash([]); // Reset dashed border for everything else
        }

        // ==========================================
        // 8. DRAW VELOCITY LANE (RIGHT SIDE)
        // ==========================================
        if (velCanvas && velCtx) {
            const vw = velCanvas.width / dpr;
            const vh = velCanvas.height / dpr;
            velCtx.fillStyle = '#111';
            velCtx.fillRect(0, 0, vw, vh);

            // Draw 50% vertical guideline
            velCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            velCtx.lineWidth = 1;
            velCtx.beginPath();
            velCtx.moveTo(vw / 2, 0);
            velCtx.lineTo(vw / 2, vh);
            velCtx.stroke();

            // ONLY draw the active track to prevent visual clutter
            let activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
            let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            let activeTrack = (activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8]) || [];
            let activeColor = trackColors[activeIdx];

            activeTrack.forEach(evt => {
                // Y-coordinate represents the exact START TIME of the note
                const yStart = h - ((evt.timeOffset - prScrollTime) * prZoomY);

                // Don't draw if the start of the note is off-screen
                if (yStart < 0 || yStart > h) return;

                const isSelected = typeof prSelectedNotes !== 'undefined' && prSelectedNotes.has(evt);
                const drawColor = isSelected ? '#ffeb3b' : activeColor;

                // --- THE VELOCITY NORMALIZATION FIX ---
                // Default to the current UI slider velocity if undefined
                let rawVel = evt.velocity !== undefined ? evt.velocity : (typeof currentVelocity !== 'undefined' ? currentVelocity : 100);
                
                // Strictly enforce the 1-127 scale. 
                // This guarantees that a MIDI velocity of 1 evaluates to ~0.007 (1% width), 
                // completely eliminating the 100% rogue spikes!
                let normalizedVel = Math.max(1, Math.min(127, rawVel)) / 127.0;

                const velW = normalizedVel * vw;

                // Draw a sleek "Lollipop" graph (standard DAW velocity aesthetic)
                velCtx.strokeStyle = drawColor;
                velCtx.lineWidth = 2;
                velCtx.beginPath();
                velCtx.moveTo(0, yStart);
                velCtx.lineTo(velW, yStart);
                velCtx.stroke();

                velCtx.fillStyle = drawColor;
                velCtx.beginPath();
                velCtx.arc(velW, yStart, 3, 0, Math.PI * 2);
                velCtx.fill();
            });
        }
    } // <-- End of drawPianoRoll()

    // =====================================================================
    // PIANO ROLL: HIT DETECTION & EDITING LOGIC
    // =====================================================================

    // Convert Canvas Y-Pixel to Time (Seconds)
    function getPrTimeFromY(yPixel) {
        const rect = prCanvas.getBoundingClientRect();
        return prScrollTime + ((rect.height - yPixel) / prZoomY);
    }

    // Convert Canvas X-Pixel to MIDI Note (0-127)
    function getPrNoteFromX(xPixel) {
        const rect = prCanvas.getBoundingClientRect();
        const totalVisibleNotes = (currentPianoMax - currentPianoMin) + 1;
        const noteW = rect.width / totalVisibleNotes;
        const noteOffset = Math.floor(xPixel / noteW);
        return currentPianoMin + noteOffset;
    }

    // Convert Time (Seconds) to closest snapped Grid division
    function snapTime(timeSec) {
        if (prSnapRes === 0) return timeSec;
        const beatSecs = 60 / currentArpBPM;
        const snapSecs = beatSecs * prSnapRes;
        return Math.round(timeSec / snapSecs) * snapSecs;
    }

    // State trackers for Editing and Selecting
    let prSelectedNotes = new Set();
    let prDragState = {
        isDragging: false,
        isMarquee: false,
        isResizing: false, 
        isGroupResizing: false,
        groupResizeHandle: null, // 'top' or 'bottom'
        groupOrigStart: 0,
        groupOrigEnd: 0,
        tool: null,
        noteRef: null,
        originalTimeOffset: 0,
        originalDuration: 0,
        marqueeStart: { time: 0, note: 0 },
        marqueeCurrent: { time: 0, note: 0 },
        moveCache: new Map(), // Stores original states of notes before a group move/resize
        moveAnchor: { time: 0, note: 0 },
        auditionVoices: []
    };

    function getSelectionBounds() {
        if (prSelectedNotes.size === 0) return null;
        let minT = Infinity, maxT = -Infinity, minN = Infinity, maxN = -Infinity;
        
        prSelectedNotes.forEach(evt => {
            const start = evt.timeOffset !== undefined ? evt.timeOffset : evt.start;
            const dur = evt.duration !== undefined ? evt.duration : (evt.end - evt.start);
            if (start < minT) minT = start;
            if (start + dur > maxT) maxT = start + dur;

            let notes = [];
            if (evt.type === 'play' && evt.freqs) notes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
            else if (evt.type === 'drum') notes = [parseInt(Object.keys(gmDrumMap).find(k => gmDrumMap[k].alias === evt.drumType)) || 36];
            else if (evt.type === 'stem') { minN = 0; maxN = 127; } // Stems span the whole track
            
            notes.forEach(n => { if (n < minN) minN = n; if (n > maxN) maxN = n; });
        });
        return { minT, maxT, minN, maxN };
    }

    function eraseNoteAt(time, note, track) {
        // --- THE ALIAS FIX ---
        const targetDrum = gmDrumMap[note] ? gmDrumMap[note].alias : null;
        
        for (let i = track.length - 1; i >= 0; i--) {
            const evt = track[i];
            const end = evt.timeOffset + (evt.duration || 0.5);
            if (time >= evt.timeOffset && time <= end) {
                
                if (evt.type === 'stem') {
                    prSelectedNotes.delete(evt);
                    track.splice(i, 1);
                    break;
                }
                else if (evt.type === 'play' && evt.freqs) {
                    const evtNotes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                    if (evtNotes.includes(note)) {
                        prSelectedNotes.delete(evt);
                        track.splice(i, 1);
                        break;
                    }
                }
                else if (evt.type === 'drum' && evt.drumType === targetDrum) {
                    prSelectedNotes.delete(evt);
                    track.splice(i, 1);
                    break;
                }
            }
        }
    }

    // Helper: Find a specific note event under the cursor
    function getEventAtCursor(time, note, track) {
        // --- THE ALIAS FIX ---
        const targetDrum = gmDrumMap[note] ? gmDrumMap[note].alias : null;
        
        for (let i = track.length - 1; i >= 0; i--) {
            const evt = track[i];
            const end = evt.timeOffset + (evt.duration || 0.5);
            if (time >= evt.timeOffset && time <= end) {
                
                // Stems span the whole X-axis, so if the time matches, it's a hit!
                if (evt.type === 'stem') {
                    return { evt, originalNote: note }; 
                }
                
                if (evt.type === 'play' && evt.freqs) {
                    const evtNotes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                    if (evtNotes.includes(note)) return { evt, originalNote: note };
                } else if (evt.type === 'drum' && evt.drumType === targetDrum) {
                    return { evt, originalNote: note };
                }
            }
        }
        return null;
    }

    if (prCanvas) {
        // --- 1. MOUSE DOWN ---
        prCanvas.addEventListener('mousedown', (e) => {
            if (!isPianoRollActive) return;

            initAudio();
            const clickTime = getPrTimeFromY(e.offsetY);
            const clickNote = getPrNoteFromX(e.offsetX);
            const snappedTime = snapTime(clickTime);

            // --- SHIFT-CLICK PLAYHEAD PLACEMENT ---
            if (e.shiftKey) {
                prDragState.isDragging = false; // Abort all standard tool logic
                
                if (typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
                    stepCursorTime = Math.max(0, snappedTime);
                } else {
                    const activeDomain = studio.lastSelectedDomain;
                    if (activeDomain === 'arranger') {
                        if (arranger.isPlaying) arranger.startTime = audioCtx.currentTime - snappedTime;
                        else arranger.pauseTime = Math.max(0, snappedTime);
                        lastArrangerPhase = snappedTime - 0.01;
                    } else if (activeDomain === 'looper') {
                        const activeIdx = studio.activeLooperTrack;
                        looper.lastPhases[activeIdx] = Math.max(0, snappedTime);
                        if (looper.isPlaying) looper.startTime = audioCtx.currentTime - snappedTime;
                    }
                    syncTransportToTime(snappedTime); // Update LCD!
                }
                if (typeof drawPianoRoll === 'function') drawPianoRoll();
                return; 
            }

            // --- STEP ENTRY CURSOR TELEPORT ---
            if (typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
                stepCursorTime = Math.max(0, snappedTime);
                if (typeof drawPianoRoll === 'function') drawPianoRoll();
                return; // Stop the standard draw/select/erase tools from firing!
            }

            let activeDomain = studio.lastSelectedDomain;
            let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            let activeTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];
            const isDrumTrack = studio.trackTypes[activeIdx] === 'drum';

            // Initialize empty track if needed
            if (studio.trackTypes[activeIdx] === null) {
                studio.trackTypes[activeIdx] = 'voice';
                document.querySelector(`.track-btn[data-track="${activeIdx}"]`)?.classList.add('type-voice');
                const labelEl = document.getElementById(`inst-label-${activeIdx}`);
                const instSelect = document.getElementById('instrumentPreset');
                if (labelEl && instSelect) labelEl.textContent = instSelect.options[instSelect.selectedIndex].text;
            }

            prDragState.isDragging = true;
            prDragState.tool = currentPrTool;

            // --- INTERCEPT: Did they click the Loop Boundary? ---
            if (activeDomain === 'looper') {
                const beatSecs = 60 / currentArpBPM;
                const lenEl = document.getElementById('looperLength');
                const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * beatSecs;
                const loopSec = looper.trackDurations[activeIdx] || globalLoopSec;
                const loopEndY = prCanvas.height / (window.devicePixelRatio || 1) - ((loopSec - prScrollTime) * prZoomY);

                if (Math.abs(e.offsetY - loopEndY) < 8) {
                    prDragState.tool = 'loop_brace';
                    prSelectedNotes.clear(); // Clear any selections
                    return; // Stop standard draw/select logic
                }
            }

            // --- SELECT TOOL ---
            if (currentPrTool === 'select') {

                // --- NEW: CHECK GROUP RESIZE HANDLES FIRST ---
                if (prSelectedNotes.size > 1) {
                    const bounds = getSelectionBounds();
                    if (bounds) {
                        const yBottom = (prCanvas.height / (window.devicePixelRatio || 1)) - ((bounds.minT - prScrollTime) * prZoomY);
                        const yTop = (prCanvas.height / (window.devicePixelRatio || 1)) - ((bounds.maxT - prScrollTime) * prZoomY);
                        
                        // Give the handles a generous 12px hit margin. 
                        // Because we only check Y, clicking the middle of the box passes right through to the notes!
                        if (Math.abs(e.offsetY - yTop) < 12) {
                            prDragState.isGroupResizing = true;
                            prDragState.groupResizeHandle = 'top';
                        } else if (Math.abs(e.offsetY - yBottom) < 12) {
                            prDragState.isGroupResizing = true;
                            prDragState.groupResizeHandle = 'bottom';
                        }

                        if (prDragState.isGroupResizing) {
                            prDragState.groupOrigStart = bounds.minT;
                            prDragState.groupOrigEnd = bounds.maxT;
                            prDragState.moveCache.clear();
                            prSelectedNotes.forEach(evt => {
                                prDragState.moveCache.set(evt, { 
                                    timeOffset: evt.timeOffset !== undefined ? evt.timeOffset : evt.start, 
                                    duration: evt.duration !== undefined ? evt.duration : (evt.end - evt.start) 
                                });
                            });
                            return; // Stop here! We grabbed a group handle.
                        }
                    }
                }

                const hit = getEventAtCursor(clickTime, clickNote, activeTrack);

                if (hit) {
                    const evt = hit.evt;
                    // Check if we clicked the TOP edge of the note to resize its duration
                    const yTop = (prCanvas.height / (window.devicePixelRatio || 1)) - (((evt.timeOffset + (evt.duration || 0.5)) - prScrollTime) * prZoomY);

                    if (Math.abs(e.offsetY - yTop) < 10) {
                        prDragState.isResizing = true;
                        prDragState.originalTimeOffset = snappedTime;

                        if (!prSelectedNotes.has(evt)) {
                            prSelectedNotes.clear();
                            prSelectedNotes.add(evt);
                        }

                        prDragState.moveCache.clear();
                        prSelectedNotes.forEach(selectedEvt => {
                            prDragState.moveCache.set(selectedEvt, { duration: selectedEvt.duration || 0.5 });
                        });
                        return; // Skip normal move logic
                    }

                    // We clicked a note body! Normal Move Mode
                    if (!prSelectedNotes.has(evt)) {
                        prSelectedNotes.clear();
                        prSelectedNotes.add(evt);
                    }

                    // Prepare to Move the group
                    prDragState.moveAnchor = { time: snappedTime, note: clickNote };
                    prDragState.moveCache.clear();

                    // THE FIX: Cache an ARRAY of all pitches so chords don't get collapsed!
                    prSelectedNotes.forEach(evt => {
                        let originalPitches = [];
                        if (evt.type === 'play' && evt.freqs) {
                            originalPitches = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                        } else if (evt.type === 'drum') {
                            const drumPitch = parseInt(Object.keys(gmDrumMap).find(k => gmDrumMap[k].alias === evt.drumType)) || 36;
                            originalPitches = [drumPitch];
                        }

                        prDragState.moveCache.set(evt, {
                            timeOffset: evt.timeOffset,
                            pitches: originalPitches,
                            // Save original Tonnetz coords so shifting pitch doesn't crash the harmony engine later!
                            originalSt: evt.stArray ? [...evt.stArray] : null
                        });
                    });
                } else {
                    // We clicked empty space! Start a Marquee Selection
                    prSelectedNotes.clear();
                    prDragState.isMarquee = true;
                    prDragState.marqueeStart = { time: clickTime, note: clickNote };
                    prDragState.marqueeCurrent = { time: clickTime, note: clickNote };
                }
            }
            // --- COPY TOOL ---
            else if (currentPrTool === 'copy') {
                const hit = getEventAtCursor(clickTime, clickNote, activeTrack);
                
                // Region hit detection
                let hitRegion = null;
                if (!hit && activeDomain === 'looper' && looper.regions[activeIdx]) {
                    hitRegion = looper.regions[activeIdx].find(r => clickTime >= r.start && clickTime <= r.end);
                }

                if (hit || hitRegion) {
                    // --- Properly unwrap the 'hit' object! ---
                    const target = hit ? hit.evt : hitRegion;
                    
                    // If clicking an unselected item, select only it
                    if (!prSelectedNotes.has(target)) {
                        prSelectedNotes.clear();
                        prSelectedNotes.add(target);
                    }

                    // --- THE CLONE ENGINE ---
                    const newSelection = new Set();
                    prDragState.moveCache.clear();
                    
                    prSelectedNotes.forEach(item => {
                        const clone = { ...item, id: Math.random() };
                        
                        if (item.freqs) clone.freqs = [...item.freqs];
                        if (item.stArray) clone.stArray = [...item.stArray];
                        
                        if (item.start !== undefined && activeDomain === 'looper') {
                            looper.regions[activeIdx].push(clone);
                        } else {
                            activeTrack.push(clone);
                        }
                        
                        newSelection.add(clone);
                        
                        let originalPitches = [];
                        if (clone.type === 'play' && clone.freqs) {
                            originalPitches = clone.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                        } else if (clone.type === 'drum') {
                            const drumPitch = parseInt(Object.keys(gmDrumMap).find(k => gmDrumMap[k].alias === clone.drumType)) || 36;
                            originalPitches = [drumPitch];
                        }
                        
                        prDragState.moveCache.set(clone, {
                            timeOffset: clone.timeOffset !== undefined ? clone.timeOffset : clone.start,
                            pitches: originalPitches,
                            originalSt: clone.stArray ? [...clone.stArray] : null
                        });
                    });
                    
                    prSelectedNotes = newSelection;

                    // Initialize drag exactly like the Select tool
                    prDragState.isDragging = true;
                    prDragState.tool = 'select'; // <--- WE USE 'select' NOW
                    prDragState.moveAnchor = { time: snappedTime, note: clickNote };
                    
                } else {
                    // Start Marquee Selection if clicking empty space...
                    prSelectedNotes.clear();
                    prDragState.isMarquee = true;
                    prDragState.tool = 'select'; // Acts like a standard selection box
                    prDragState.marqueeStart = { time: clickTime, note: clickNote };
                    prDragState.marqueeCurrent = { time: clickTime, note: clickNote };
                }
            }
            // --- REGION TOOL ---
            else if (currentPrTool === 'region') {
                if (activeDomain !== 'looper') {
                    showToast("Regions can only be drawn on Looper tracks.");
                    return;
                }
                prDragState.isDragging = true;
                prDragState.tool = 'region';
                
                const beatSecs = 60 / currentArpBPM;
                const defaultDur = prSnapRes > 0 ? (beatSecs * prSnapRes) : (beatSecs * 4); // Default to 1 full bar
                
                const newRegion = { start: snappedTime, end: snappedTime + defaultDur };
                looper.regions[activeIdx].push(newRegion);
                prDragState.noteRef = newRegion; // We reuse noteRef to track resizing!
                prDragState.originalTimeOffset = snappedTime;

                // --- Instantly expand global timeline when painting a region! ---
                if (newRegion.end > arranger.duration) {
                    arranger.duration = newRegion.end;
                }
            }
            // --- ERASE TOOL ---
            else if (currentPrTool === 'erase') {
                let erasedRegion = false;
                
                // Check if we clicked a Region block first
                if (activeDomain === 'looper') {
                    const hitRegionIndex = looper.regions[activeIdx].findIndex(r => clickTime >= r.start && clickTime <= r.end);
                    if (hitRegionIndex !== -1) {
                        looper.regions[activeIdx].splice(hitRegionIndex, 1);
                        erasedRegion = true;
                        if (typeof drawPianoRoll === 'function') drawPianoRoll();
                    }
                }

                if (!erasedRegion) {
                    const hit = getEventAtCursor(clickTime, clickNote, activeTrack);
                    if (hit) {
                        eraseNoteAt(clickTime, clickNote, activeTrack); // Single brush erase
                    } else {
                        // Start Marquee Erase
                        prSelectedNotes.clear();
                        prDragState.isMarquee = true;
                        prDragState.tool = 'erase';
                        prDragState.marqueeStart = { time: clickTime, note: clickNote };
                        prDragState.marqueeCurrent = { time: clickTime, note: clickNote };
                    }
                }
            }
            // --- DRAW TOOL ---
            else if (currentPrTool === 'draw') {
                prSelectedNotes.clear(); // Clear selection when drawing
                const noteFreq = masterTune * Math.pow(2, (clickNote - 69) / 12);
                const beatSecs = 60 / currentArpBPM;
                const defaultDur = prSnapRes > 0 ? (beatSecs * prSnapRes) : (beatSecs * 0.25);
                const drumType = isDrumTrack ? (gmDrumMap[clickNote] ? gmDrumMap[clickNote].alias : null) : null;

                if (isDrumTrack && !drumType) return;

                // THE FIX: Use the global currentVelocity state instead of hardcoding 1 or 100
                const newEvent = isDrumTrack ? {
                    id: Date.now(), timeOffset: snappedTime, duration: defaultDur, type: 'drum', drumType: drumType, velocity: currentVelocity
                } : {
                    id: Date.now(), timeOffset: snappedTime, duration: defaultDur, type: 'play', freqs: [noteFreq], velocity: currentVelocity, stArray: null
                };

                activeTrack.push(newEvent);
                activeTrack.sort((a, b) => a.timeOffset - b.timeOffset);

                prDragState.noteRef = newEvent;
                prDragState.originalTimeOffset = snappedTime;
                prDragState.originalDuration = defaultDur;
                prDragState.auditionVoices = [];

                const destNode = activeDomain === 'looper' ? looperGainNodes[activeIdx] : linearGainNodes[activeIdx - 8];
                if (isDrumTrack) {
                    playDrum(drumType, audioCtx.currentTime, 1, destNode);
                } else if (studio.trackSynthStates[activeIdx]) {
                    const voice = spawnVoice(noteFreq, audioCtx.currentTime, 0, 1, false, studio.trackSynthStates[activeIdx], destNode);
                    prDragState.auditionVoices.push(voice);
                }
            }
        });

        // --- 2. MOUSE MOVE ---
        prCanvas.addEventListener('mousemove', (e) => {
            if (!isPianoRollActive) return;

            // 1. Declare state globally for both Hover and Drag logic
            let activeDomain = studio.lastSelectedDomain;
            let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            let activeTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];
            const isDrumTrack = studio.trackTypes[activeIdx] === 'drum';

            const currentTime = getPrTimeFromY(e.offsetY);
            const currentNote = getPrNoteFromX(e.offsetX);
            const snappedCurrent = snapTime(currentTime);

            // 2. --- HOVER DETECTION (Runs even when NOT dragging) ---
            let isHoveringBoundary = false;
            let isHoveringEdge = false;

            if (!prDragState.isDragging) {
                if (activeDomain === 'looper') {
                    const beatSecs = 60 / currentArpBPM;
                    const lenEl = document.getElementById('looperLength');
                    const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * beatSecs;
                    const loopSec = looper.trackDurations[activeIdx] || globalLoopSec;
                    const loopEndY = (prCanvas.height / (window.devicePixelRatio || 1)) - ((loopSec - prScrollTime) * prZoomY);

                    if (Math.abs(e.offsetY - loopEndY) < 8) isHoveringBoundary = true;
                }

                if (currentPrTool === 'select') {
                    const hit = getEventAtCursor(currentTime, currentNote, activeTrack);
                    if (hit) {
                        const yTop = (prCanvas.height / (window.devicePixelRatio || 1)) - (((hit.evt.timeOffset + (hit.evt.duration || 0.5)) - prScrollTime) * prZoomY);
                        if (Math.abs(e.offsetY - yTop) < 10) isHoveringEdge = true;
                    }
                }
            }

            // Set the cursor dynamically
            prCanvas.style.cursor = (isHoveringBoundary || isHoveringEdge) ? 'ns-resize' : (currentPrTool === 'draw' ? 'cell' : 'crosshair');

            // 3. --- DRAGGING LOGIC (Bail out if the mouse button isn't held down) ---
            if (!prDragState.isDragging) return;

            // --- LOOP BRACE TOOL ---
            if (prDragState.tool === 'loop_brace') {
                const beatSecs = 60 / currentArpBPM;
                const minLoopSec = prSnapRes > 0 ? (beatSecs * prSnapRes * 4) : (beatSecs * 0.25);
                looper.trackDurations[activeIdx] = Math.max(minLoopSec, snappedCurrent);
                return;
            }

            // --- SELECT TOOL (Marquee or Move) ---
            if (prDragState.tool === 'select') {
                if (prDragState.isMarquee) {
                    prDragState.marqueeCurrent = { time: currentTime, note: currentNote };

                    const minT = Math.min(prDragState.marqueeStart.time, currentTime);
                    const maxT = Math.max(prDragState.marqueeStart.time, currentTime);
                    const minN = Math.min(prDragState.marqueeStart.note, currentNote);
                    const maxN = Math.max(prDragState.marqueeStart.note, currentNote);

                    prSelectedNotes.clear();

                    activeTrack.forEach(evt => {
                        const endT = evt.timeOffset + (evt.duration || 0.5);
                        let noteMatch = false;

                        if (evt.type === 'play' && evt.freqs) {
                            const evtNotes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                            noteMatch = evtNotes.some(n => n >= minN && n <= maxN);
                        } else if (evt.type === 'drum') {
                            // --- THE ALIAS FIX ---
                            const drumPitch = parseInt(Object.keys(gmDrumMap).find(k => gmDrumMap[k].alias === evt.drumType)) || 36;
                            noteMatch = drumPitch >= minN && drumPitch <= maxN;
                        }

                        if (noteMatch && (endT >= minT && evt.timeOffset <= maxT)) {
                            prSelectedNotes.add(evt);
                        }
                    });
                }
                else if (prDragState.isResizing) {
                    const timeDiff = snappedCurrent - prDragState.originalTimeOffset;
                    prSelectedNotes.forEach(evt => {
                        const original = prDragState.moveCache.get(evt);
                        if (original) {
                            const minDur = prSnapRes > 0 ? snapTime(0.01) || 0.05 : 0.05;
                            evt.duration = Math.max(minDur, original.duration + timeDiff);
                        }
                    });
                }
                else if (prDragState.isGroupResizing) {
                    const origStart = prDragState.groupOrigStart;
                    const origEnd = prDragState.groupOrigEnd;
                    const origDur = origEnd - origStart;
                    
                    let newStart = origStart;
                    let newEnd = origEnd;
                    const minDur = prSnapRes > 0 ? snapTime(0.01) || 0.05 : 0.05;

                    if (prDragState.groupResizeHandle === 'top') {
                        // Dragging the Top Handle changes the End Time!
                        newEnd = Math.max(origStart + minDur, snappedCurrent);
                    } else {
                        // Dragging the Bottom Handle changes the Start Time!
                        newStart = Math.min(origEnd - minDur, Math.max(0, snappedCurrent));
                    }
                    
                    const newDur = newEnd - newStart;
                    const ratio = origDur > 0 ? (newDur / origDur) : 1;

                    let draggedMaxTime = 0;

                    prSelectedNotes.forEach(evt => {
                        const original = prDragState.moveCache.get(evt);
                        if (original) {
                            const relativeStart = original.timeOffset - origStart;
                            
                            // The Elastic Math!
                            const newTimeOffset = newStart + (relativeStart * ratio);
                            const newEventDur = original.duration * ratio;
                            
                            if (evt.start !== undefined) { 
                                evt.start = newTimeOffset;
                                evt.end = newTimeOffset + newEventDur;
                                if (evt.end > draggedMaxTime) draggedMaxTime = evt.end;
                            } else { 
                                evt.timeOffset = newTimeOffset;
                                evt.duration = newEventDur;
                                if (evt.timeOffset + evt.duration > draggedMaxTime) draggedMaxTime = evt.timeOffset + evt.duration;
                            }
                        }
                    });

                    // Instantly expand the global timeline if stretched past the end!
                    if (draggedMaxTime > arranger.duration) {
                        arranger.duration = draggedMaxTime;
                    }
                }
                else if (prDragState.moveCache.size > 0) {
                    const deltaTime = snappedCurrent - prDragState.moveAnchor.time;
                    const deltaNote = currentNote - prDragState.moveAnchor.note;

                    let draggedMaxTime = 0;

                    prSelectedNotes.forEach(evt => {
                        const original = prDragState.moveCache.get(evt);
                        if (!original) return;

                        // Check if we are moving a Region or a standard Note
                        if (evt.start !== undefined) {
                            const dur = evt.end - evt.start;
                            evt.start = Math.max(0, original.timeOffset + deltaTime);
                            evt.end = evt.start + dur;
                            if (evt.end > draggedMaxTime) draggedMaxTime = evt.end; // Track region boundary
                        } else {
                            evt.timeOffset = Math.max(0, original.timeOffset + deltaTime);
                            const endT = evt.timeOffset + (evt.duration || 0.25);
                            if (endT > draggedMaxTime) draggedMaxTime = endT; // Track note boundary
                        }

                        // Pitch Shifting (Ignored for Drums and Regions)
                        if (!isDrumTrack && evt.type === 'play') {
                            evt.freqs = original.pitches.map(p => {
                                const newMidi = Math.max(0, Math.min(127, p + deltaNote));
                                return masterTune * Math.pow(2, (newMidi - 69) / 12);
                            });
                            if (original.originalSt) {
                                evt.stArray = original.originalSt.map(st => st + deltaNote);
                            }
                        }
                    });

                    // --- Instantly expand the global timeline (if needed)! ---
                    if (draggedMaxTime > arranger.duration) {
                        arranger.duration = draggedMaxTime;
                    }
                }
            }
            // --- LOOPER REGION TOOL ---
            else if (prDragState.tool === 'region' && prDragState.noteRef) {
                const origStart = prDragState.originalTimeOffset;
                const minDur = prSnapRes > 0 ? snapTime(0.01) || 0.05 : 0.05;

                if (snappedCurrent < origStart) {
                    prDragState.noteRef.start = Math.max(0, snappedCurrent);
                    prDragState.noteRef.end = origStart;
                } else {
                    prDragState.noteRef.start = origStart;
                    prDragState.noteRef.end = Math.max(origStart + minDur, snappedCurrent);
                }
                
                // If a region is dragged past the current end of the song, expand the global timeline!
                if (prDragState.noteRef.end > arranger.duration) {
                    arranger.duration = prDragState.noteRef.end;
                }
            }
            // --- ERASE TOOL ---
            else if (prDragState.tool === 'erase') {
                if (prDragState.isMarquee) {
                    prDragState.marqueeCurrent = { time: currentTime, note: currentNote };
                } else {
                    eraseNoteAt(currentTime, currentNote, activeTrack); // Standard brush
                }
            }
            // --- DRAW TOOL ---
            else if (prDragState.tool === 'draw' && prDragState.noteRef) {
                const origStart = prDragState.originalTimeOffset;
                const defaultDur = prDragState.originalDuration;
                const minDur = prSnapRes > 0 ? (60 / currentArpBPM * prSnapRes * 4) : 0.05;

                if (snappedCurrent < origStart) {
                    prDragState.noteRef.timeOffset = Math.max(0, snappedCurrent);
                    prDragState.noteRef.duration = (origStart - prDragState.noteRef.timeOffset) + defaultDur;
                } else {
                    prDragState.noteRef.timeOffset = origStart;
                    prDragState.noteRef.duration = Math.max(minDur, (snappedCurrent - origStart) + defaultDur);
                }
            }
        });
    }

    // --- 3. MOUSE UP (Stop Dragging, Kill Synth, Update Timelines) ---
    window.addEventListener('mouseup', () => {
        if (prDragState.isDragging) {
            
            // --- MARQUEE ABORT (CLICK-TO-PLACE PLAYHEAD) ---
            if (prDragState.isMarquee) {
                const timeDiff = Math.abs(prDragState.marqueeStart.time - prDragState.marqueeCurrent.time);
                const noteDiff = Math.abs(prDragState.marqueeStart.note - prDragState.marqueeCurrent.note);

                // If the mouse barely moved, treat it as a click on empty space!
                if (timeDiff < 0.05 && noteDiff < 1) {
                    const snappedTime = snapTime(prDragState.marqueeStart.time);
                    const activeDomain = studio.lastSelectedDomain;
                    
                    if (activeDomain === 'arranger') {
                        if (arranger.isPlaying) arranger.startTime = audioCtx.currentTime - snappedTime;
                        else arranger.pauseTime = Math.max(0, snappedTime);
                        lastArrangerPhase = snappedTime - 0.01;
                    } else if (activeDomain === 'looper') {
                        const activeIdx = studio.activeLooperTrack;
                        looper.lastPhases[activeIdx] = Math.max(0, snappedTime);
                        if (looper.isPlaying) looper.startTime = audioCtx.currentTime - snappedTime;
                    }
                    
                    syncTransportToTime(snappedTime); // Update LCD!
                    prDragState.isMarquee = false; // Abort marquee selection loop!
                    if (typeof drawPianoRoll === 'function') drawPianoRoll();
                }
            }

            // --- MARQUEE ERASE ---
            if (prDragState.isMarquee && prDragState.tool === 'erase') {
                const minT = Math.min(prDragState.marqueeStart.time, prDragState.marqueeCurrent.time);
                const maxT = Math.max(prDragState.marqueeStart.time, prDragState.marqueeCurrent.time);
                const minN = Math.min(prDragState.marqueeStart.note, prDragState.marqueeCurrent.note);
                const maxN = Math.max(prDragState.marqueeStart.note, prDragState.marqueeCurrent.note);

                let activeDomain = studio.lastSelectedDomain;
                let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
                let activeTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];

                // Loop backwards so `splice` doesn't break our index!
                for (let i = activeTrack.length - 1; i >= 0; i--) {
                    const evt = activeTrack[i];
                    const endT = evt.timeOffset + (evt.duration || 0.5);
                    let noteMatch = false;

                    if (evt.type === 'stem') {
                        noteMatch = true; 
                    }
                    else if (evt.type === 'play' && evt.freqs) {
                        const evtNotes = evt.freqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                        noteMatch = evtNotes.some(n => n >= minN && n <= maxN);
                    }
                    else if (evt.type === 'drum') {
                        const drumPitch = parseInt(Object.keys(gmDrumMap).find(k => gmDrumMap[k].alias === evt.drumType)) || 36;
                        noteMatch = drumPitch >= minN && drumPitch <= maxN;
                    }

                    if (noteMatch && (endT >= minT && evt.timeOffset <= maxT)) {
                        activeTrack.splice(i, 1);
                    }
                }
                
                // --- Wipe looper regions inside the Marquee box! ---
                if (activeDomain === 'looper') {
                    for (let i = looper.regions[activeIdx].length - 1; i >= 0; i--) {
                        const r = looper.regions[activeIdx][i];
                        if (r.start <= maxT && r.end >= minT) {
                            looper.regions[activeIdx].splice(i, 1);
                        }
                    }
                }

                if (typeof drawPianoRoll === 'function') drawPianoRoll();
            }

            prDragState.isDragging = false;
            prDragState.isMarquee = false;
            prDragState.isResizing = false;
            prDragState.isGroupResizing = false;
            prDragState.groupResizeHandle = null;
            prDragState.noteRef = null;
            prDragState.moveCache.clear();

            if (prDragState.auditionVoices && prDragState.auditionVoices.length > 0) {
                beginRelease(prDragState.auditionVoices, false);
                prDragState.auditionVoices = [];
            }

            // Ensure the sequencer knows the song just got longer!
            let activeDomain = studio.lastSelectedDomain;
            if (activeDomain === 'arranger') {
                let maxDur = 0;
                arranger.tracks.forEach(t => t.forEach(evt => {
                    if (evt.timeOffset + (evt.duration || 0.5) > maxDur) maxDur = evt.timeOffset + (evt.duration || 0.5);
                }));
                arranger.duration = maxDur;
            } else if (activeDomain === 'looper') {
                const lenEl = document.getElementById('looperLength');
                const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * (60 / currentArpBPM);
                let activeIdx = studio.activeLooperTrack;
                if (!looper.trackDurations[activeIdx]) {
                    looper.trackDurations[activeIdx] = globalLoopSec;
                }
            }
        }
    });

    // =======================================================
    // PIANO ROLL CONTEXTUAL ACTIONS & GLOBAL TIME
    // =======================================================

const btnQuantize = document.getElementById('prActionQuantize');
    if (btnQuantize) {
        btnQuantize.onclick = () => {
            if (!prSelectedNotes || prSelectedNotes.size === 0) {
                showToast("No notes selected to quantize");
                return;
            }
            
            const snapVal = parseFloat(document.getElementById('prSnapGrid')?.value || 0);
            if (snapVal <= 0) {
                showToast("Enable Snap to grid first");
                return;
            }
            
            const beatSecs = 60 / currentArpBPM;
            const snapSecs = snapVal * beatSecs;
            
            prSelectedNotes.forEach(evt => {
                if (evt.start !== undefined) {
                    // --- REGION SNAP ---
                    // Snap the start to the absolute grid line
                    const snappedStart = Math.round(evt.start / snapSecs) * snapSecs;
                    // Snap the end, guaranteeing it is at least 1 snap unit long
                    const snappedEnd = Math.max(snappedStart + snapSecs, Math.round(evt.end / snapSecs) * snapSecs);
                    
                    evt.start = snappedStart;
                    evt.end = snappedEnd;
                } else {
                    // --- NOTE SNAP ---
                    // Snap the start to the absolute grid line
                    const snappedStart = Math.round(evt.timeOffset / snapSecs) * snapSecs;
                    // Force the duration to be a perfect multiple of the grid
                    const snappedDur = Math.max(snapSecs, Math.round((evt.duration || 0.5) / snapSecs) * snapSecs);
                    
                    evt.timeOffset = snappedStart;
                    evt.duration = snappedDur;
                }
            });

            // Re-sort the active track chronologically so the rendering engine doesn't glitch
            const activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
            const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            const activeTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];
            
            if (activeTrack) {
                activeTrack.sort((a, b) => 
                    (a.timeOffset !== undefined ? a.timeOffset : a.start) - 
                    (b.timeOffset !== undefined ? b.timeOffset : b.start)
                );
            }
            
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
            showToast("Selected notes quantized");
        };
    }

    const btnLegato = document.getElementById('prActionLegato');
    if (btnLegato) {
        btnLegato.onclick = () => {
            if (!prSelectedNotes || prSelectedNotes.size < 2) {
                showToast("Select at least 2 notes to apply legato");
                return;
            }
            
            // THE CRASH FIX: Convert the Set to an Array before sorting!
            const sortedNotes = Array.from(prSelectedNotes)
                .filter(e => e.timeOffset !== undefined)
                .sort((a, b) => a.timeOffset - b.timeOffset);
            
            for (let i = 0; i < sortedNotes.length - 1; i++) {
                let currentNote = sortedNotes[i];
                let nextNote = sortedNotes[i + 1];
                
                // Stretch the current note's duration so it seamlessly meets the start of the next note
                if (currentNote.timeOffset < nextNote.timeOffset) {
                    currentNote.duration = nextNote.timeOffset - currentNote.timeOffset;
                }
            }
            
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
            showToast("Legato applied");
        };
    }

    function modifyGlobalTime(isAdding) {
        const barDurationSecs = (60 / currentArpBPM) * beatsPerBar;
        const shiftDuration = isAdding ? barDurationSecs : -barDurationSecs;

        // Determine where to make the cut dynamically
        const activeToolId = document.querySelector('.pr-tool-btn.active')?.id;
        let targetTimeSecs = 0;
        
        if (activeToolId === 'prToolStep' && typeof stepCursorTime !== 'undefined') {
            targetTimeSecs = stepCursorTime; 
        } else {
            const activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
            if (activeDomain === 'arranger') {
                targetTimeSecs = arranger.isPlaying && typeof audioCtx !== 'undefined' 
                    ? (audioCtx.currentTime - arranger.startTime) 
                    : arranger.pauseTime;
            } else if (activeDomain === 'looper') {
                const loopSec = looper.trackDurations[studio.activeLooperTrack] || barDurationSecs;
                let phase = looper.isPlaying && typeof audioCtx !== 'undefined' 
                    ? (audioCtx.currentTime - looper.startTime) % loopSec 
                    : 0;
                targetTimeSecs = phase >= 0 ? phase : phase + loopSec;
            }
        }

        const processTracks = (tracksArray) => {
            tracksArray.forEach(track => {
                if (!isAdding) {
                    for (let i = track.length - 1; i >= 0; i--) {
                        let evt = track[i];
                        if (evt.start !== undefined) { 
                            if (evt.start >= targetTimeSecs && evt.end <= targetTimeSecs + barDurationSecs) {
                                track.splice(i, 1);
                                continue;
                            }
                        } else { 
                            if (evt.timeOffset >= targetTimeSecs && evt.timeOffset < targetTimeSecs + barDurationSecs) {
                                track.splice(i, 1);
                                continue;
                            }
                        }
                    }
                }

                track.forEach(evt => {
                    if (evt.timeOffset >= targetTimeSecs) {
                        evt.timeOffset += shiftDuration;
                        if (evt.timeOffset < 0) evt.timeOffset = 0;
                    } else if (evt.start !== undefined && evt.start >= targetTimeSecs) {
                        evt.start += shiftDuration;
                        evt.end += shiftDuration;
                        if (evt.start < 0) evt.start = 0;
                        if (evt.end < evt.start) evt.end = evt.start;
                    } else if (evt.timeOffset !== undefined && evt.timeOffset < targetTimeSecs && (evt.timeOffset + (evt.duration || 0.5)) > targetTimeSecs) {
                        evt.duration = (evt.duration || 0.5) + shiftDuration;
                        if (evt.duration <= 0.05) evt.duration = 0.05; 
                    } else if (evt.start !== undefined && evt.start < targetTimeSecs && evt.end > targetTimeSecs) {
                        evt.end += shiftDuration;
                    }
                });
            });
        };

        processTracks(arranger.tracks);
        processTracks(looper.tracks);
        
        arranger.duration += shiftDuration;
        if (arranger.duration < barDurationSecs) arranger.duration = barDurationSecs;

        looper.trackDurations.forEach((dur, idx) => {
            if (dur > 0) {
                looper.trackDurations[idx] = Math.max(barDurationSecs, dur + shiftDuration);
            }
        });
        
        if (typeof drawPianoRoll === 'function') drawPianoRoll();
        showToast(isAdding ? "Inserted 1 Bar" : "Deleted 1 Bar");
    }

    const btnAddBar = document.getElementById('prActionAddBar');
    const btnRemBar = document.getElementById('prActionRemBar');
    if (btnAddBar) btnAddBar.onclick = () => modifyGlobalTime(true);
    if (btnRemBar) btnRemBar.onclick = () => modifyGlobalTime(false);

    // =======================================================
    // HUMANIZE ENGINE
    // =======================================================

    // Hook up the toggle buttons to your master overlay router
    document.getElementById('btnToggleHumanize')?.addEventListener('click', () => toggleOverlay('humanize'));
    document.getElementById('btnCloseHumanize')?.addEventListener('click', () => toggleOverlay('humanize'));

    // Update Slider Labels dynamically
    const getVelocityTerm = (val) => {
        if (val < 35) return 'Pianissimo (pp)';
        if (val < 55) return 'Piano (p)';
        if (val < 75) return 'Mezzo-Piano (mp)';
        if (val < 95) return 'Mezzo-Forte (mf)';
        if (val < 115) return 'Forte (f)';
        return 'Fortissimo (ff)';
    };

    document.getElementById('humTiming')?.addEventListener('input', e => document.getElementById('lblHumTiming').textContent = e.target.value + 'ms');
    document.getElementById('humBaseVel')?.addEventListener('input', e => document.getElementById('lblHumBaseVel').textContent = getVelocityTerm(e.target.value) + ` (${e.target.value})`);
    document.getElementById('humRamp')?.addEventListener('input', e => document.getElementById('lblHumRamp').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + '%');
    document.getElementById('humVelJitter')?.addEventListener('input', e => document.getElementById('lblHumVelJitter').textContent = e.target.value + '%');

    // Standard Normal variate using Box-Muller transform
    function getGaussianRandom() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    document.getElementById('btnExecuteHumanize')?.addEventListener('click', () => {
        if (!prSelectedNotes || prSelectedNotes.size === 0) {
            showToast("No notes selected to humanize");
            return;
        }

        const timingMs = parseInt(document.getElementById('humTiming').value) || 0;
        const baseVel = parseInt(document.getElementById('humBaseVel').value) || 80;
        const rampPercent = parseInt(document.getElementById('humRamp').value) || 0;
        const velJitterPercent = parseInt(document.getElementById('humVelJitter').value) || 0;

        const timingSecs = timingMs / 1000;

        // Sort the selection chronologically to accurately calculate the Crescendo Ramp
        let notesArr = Array.from(prSelectedNotes).filter(n => n.timeOffset !== undefined);
        notesArr.sort((a, b) => a.timeOffset - b.timeOffset);

        let minTime = notesArr.length > 0 ? notesArr[0].timeOffset : 0;
        let maxTime = notesArr.length > 0 ? notesArr[notesArr.length - 1].timeOffset : 0;
        let timeSpan = maxTime - minTime;

        notesArr.forEach(evt => {
            // 1. Timing Jitter (Gaussian)
            if (timingSecs > 0) {
                let offset = (getGaussianRandom() / 3) * timingSecs; 
                evt.timeOffset = Math.max(0, evt.timeOffset + offset);
            }

            // 2. Velocity Ramp (Crescendo/Decrescendo)
            let progress = 0;
            if (timeSpan > 0.05) {
                progress = (evt.timeOffset - minTime) / timeSpan; // Float from 0.0 to 1.0
            }

            // THE UPGRADE: Non-linear, exponential expression curves!
            let rampOffset = 0;
            if (rampPercent > 0) {
                // Crescendo: Cubed curve (x^3) makes it swell dramatically at the very end
                let curvedProgress = Math.pow(progress, 3);
                rampOffset = (127 - baseVel) * (rampPercent / 100) * curvedProgress;
            } else if (rampPercent < 0) {
                // Decrescendo: Inverse cubic curve makes it drop off naturally like a human breath
                let curvedProgress = 1 - Math.pow(1 - progress, 3);
                rampOffset = (baseVel - 10) * (Math.abs(rampPercent) / 100) * curvedProgress; 
                rampOffset = -rampOffset; 
            }

            let targetVel = baseVel + rampOffset;

            // 3. Velocity Jitter (Gaussian)
            if (velJitterPercent > 0) {
                let jitterMag = 127 * (velJitterPercent / 100);
                targetVel += (getGaussianRandom() / 3) * jitterMag;
            }

            evt.velocity = Math.max(1, Math.min(127, Math.round(targetVel)));
        });

        // Re-sort the active track in case the timing jitter swapped the chronological order of two tight notes!
        const activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
        const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        const activeTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];
        
        if (activeTrack) {
            activeTrack.sort((a, b) => 
                (a.timeOffset !== undefined ? a.timeOffset : a.start) - 
                (b.timeOffset !== undefined ? b.timeOffset : b.start)
            );
        }

        if (typeof drawPianoRoll === 'function') drawPianoRoll();
        showToast("Humanized Selected Notes!");
    });

    // --- Global Visuals Engine (Oscilloscope & Background) ---
    let clipHoldUntil = 0;
    let peakHoldDb = -100;
    let bgEffectMode = 'off';
    let bgEffectIntensity = 0.60;
    let pulseEnvelope = 0;
    let rollingAverage = 0;

    function renderVisuals(time) {
        requestAnimationFrame(renderVisuals);

        if (isPianoRollActive) drawPianoRoll();

        // Strict Framerate Throttling
        if (time - lastVisualFrameTime < frameInterval) return;
        lastVisualFrameTime = time;

        if (!window.analyser) return;

        // Use our pre-allocated global array (Zero Garbage Collection)
        window.analyser.getFloatTimeDomainData(sharedVisualizerData);
        const bufferLength = sharedVisualizerData.length;

        // Audio Math: RMS and True Peak
        let sumSquares = 0;
        let peak = 0;
        for (let i = 0; i < bufferLength; i++) {
            const val = sharedVisualizerData[i];
            sumSquares += val * val;
            const absVal = Math.abs(val);
            if (absVal > peak) peak = absVal;
        }
        const rms = Math.sqrt(sumSquares / bufferLength);

        // REACTIVE BACKGROUND CALCULATION (Soft-Clipped Energy & Cubic UI)
        if (bgEffectMode !== 'off' && bgEffectIntensity > 0) {
            
            // 1. The Slow Follower (Moving Baseline)
            rollingAverage = (rollingAverage * 0.98) + (rms * 0.02);

            // 2. Isolate Transient
            let relativeHit = Math.max(0, rms - rollingAverage);

            // 3. Acoustic Physics (Energy = Amplitude Squared)
            // Multiply by 10 to bring the raw delta into a usable range before squaring
            let scaledHit = relativeHit * 10; 
            let energyHit = scaledHit * scaledHit; 

            // 4. SOFT CLIPPING (Analog Limiter)
            // Math.tanh() forces the unbounded energy spike into a strict 0.0 to 1.0 range.
            // It prevents the math from ever blowing past our visual ceiling.
            let normalizedHit = Math.tanh(energyHit);

            // 5. Asymmetric Envelope
            if (normalizedHit > pulseEnvelope) {
                pulseEnvelope = normalizedHit; // Instant jump
            } else {
                pulseEnvelope *= 0.90; // Smooth decay
            }

            // 6. UI Physics: CUBIC CURVE (x^3)
            // A cubic curve gives extreme fine-tuning at the bottom half.
            // A slider at 30% (0.3) = 0.027 multiplier.
            // A slider at 50% (0.5) = 0.125 multiplier.
            const cubicIntensity = bgEffectIntensity * bgEffectIntensity * bgEffectIntensity;

            // 7. Visual Rendering
            const isGlow = bgEffectMode === 'glow';
            const baseSize = isGlow ? 35 : 0;
            
            // Because pulseEnvelope is strictly 0.0 - 1.0, we just set the max allowed expansion in pixels/percent.
            const maxExpansion = isGlow ? 115 : 150; 
            
            const dynamicSize = baseSize + (pulseEnvelope * maxExpansion * cubicIntensity);
            
            // Absolute safety clamp
            const finalSize = Math.min(150, Math.max(baseSize, dynamicSize));
            
            document.body.style.setProperty('--bg-pulse-size', `${finalSize}%`);
        } else {
            document.body.style.setProperty('--bg-pulse-size', `0%`);
            rollingAverage = 0; 
            pulseEnvelope = 0; 
        }

        // OSCILLOSCOPE (Only draw if Mixer is visible to save CPU!)
        if (!isMixerActive) return;

        const oscCanvas = document.getElementById('oscilloscope');
        if (!oscCanvas) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = oscCanvas.getBoundingClientRect();
        if (oscCanvas.width !== Math.floor(rect.width * dpr) || oscCanvas.height !== Math.floor(rect.height * dpr)) {
            oscCanvas.width = Math.floor(rect.width * dpr);
            oscCanvas.height = Math.floor(rect.height * dpr);
        }

        const ctx = oscCanvas.getContext('2d');
        const w = oscCanvas.width;
        const h = oscCanvas.height;

        const peakDb = peak > 0.001 ? 20 * Math.log10(peak) : -60;
        const rmsDb = rms > 0.001 ? 20 * Math.log10(rms) : -60;

        if (peak >= 0.99) clipHoldUntil = Date.now() + 1500;
        const isClipping = Date.now() < clipHoldUntil;

        if (peakDb > peakHoldDb) peakHoldDb = peakDb; else peakHoldDb -= 0.8;

        const vuH = Math.floor(h * 0.40); const waveH = h - vuH; const vuY = waveH;

        ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);

        // Draw Background Grid
        ctx.lineWidth = 1 * dpr; ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; ctx.beginPath();
        for (let i = 1; i < 10; i++) { ctx.moveTo(w * i / 10, 0); ctx.lineTo(w * i / 10, waveH); }
        ctx.moveTo(0, waveH / 2); ctx.lineTo(w, waveH / 2); ctx.stroke();

        // Draw Oscilloscope Wave using sharedVisualizerData
        if (perfProfile.tier !== 'low') {
            ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#00ff41'; ctx.beginPath();
            const sliceWidth = w * 1.0 / bufferLength; let x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const y = (sharedVisualizerData[i] * -1) * (waveH / 2) + (waveH / 2);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                x += sliceWidth;
            }
            ctx.stroke();
        }

        const minDb = -48; const maxDb = 3; const rangeDb = maxDb - minDb;
        const getX = (db) => Math.max(0, Math.min(1, (db - minDb) / rangeDb)) * w;

        ctx.fillStyle = '#222'; ctx.fillRect(0, vuY, w, vuH);

        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, '#4caf50'); gradient.addColorStop(getX(-12) / w, '#4caf50');
        gradient.addColorStop(getX(-6) / w, '#ffeb3b'); gradient.addColorStop(getX(-1) / w, '#ff9800');
        gradient.addColorStop(getX(0) / w, '#f44336'); gradient.addColorStop(1, '#f44336');

        ctx.fillStyle = gradient; ctx.fillRect(0, vuY + (2 * dpr), getX(rmsDb), vuH - (4 * dpr));

        const peakX = getX(peakHoldDb);
        if (peakX > 0) { ctx.fillStyle = '#ffffff'; ctx.fillRect(peakX - (2 * dpr), vuY + (2 * dpr), 2 * dpr, vuH - (4 * dpr)); }

        // --- NEW: GAIN REDUCTION METER ---
        const grDb = compressor && compressor.reduction ? (typeof compressor.reduction === 'number' ? compressor.reduction : compressor.reduction.value) : 0;
        const absGr = Math.abs(grDb);
        if (absGr > 0.1) {
            const grWidth = getX(0) - getX(-absGr); // Calculate width of the squash
            ctx.fillStyle = 'rgba(255, 0, 0, 0.85)';
            // Draw a red bar pushing leftwards from the 0dB mark!
            ctx.fillRect(getX(0) - grWidth, vuY, grWidth, 6 * dpr);
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'; ctx.font = `bold ${9 * dpr}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        [-36, -24, -12, -6, -3, 0].forEach(db => {
            const markX = getX(db);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'; ctx.fillRect(markX, vuY, 1 * dpr, vuH);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'; ctx.fillText(db, markX, vuY + (2 * dpr));
        });

        const clipBoxW = 28 * dpr;
        ctx.fillStyle = isClipping ? '#f44336' : '#333'; ctx.fillRect(w - clipBoxW, vuY, clipBoxW, vuH);
        ctx.fillStyle = isClipping ? '#ffffff' : '#666'; ctx.font = `bold ${10 * dpr}px sans-serif`;
        ctx.fillText('CLIP', w - (clipBoxW / 2), vuY + Math.floor(vuH / 2) - (4 * dpr));
    }


    function initAudio() {
        // --- FORCE WAKE IN CASE OF AUDIO THROTTLING ---
        if (audioCtx) {
            if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
                audioCtx.resume().then(() => {
                    console.log("Audio Engine force-awakened by physical user gesture!");
                }).catch(err => console.warn(err));
            }
            return;
        }

        // latencyHint: Politely demand high-priority hardware threading
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

        // --- NATIVE AUDIO STATE CHANGE LISTENER ---
        audioCtx.onstatechange = () => {
            if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
                if (typeof globalTimeDisplay !== 'undefined' && globalTimeDisplay) {
                    globalTimeDisplay.textContent = "Zzz...";
                }
                const arrStatus = document.getElementById('arranger-status-text');
                if (arrStatus) arrStatus.textContent = "AUDIO SUSPENDED";
            }
        };

        // --- SILENT BACKGROUND WAKE LOCK ---
        // A silent oscillator prevents modern browsers (especially Firefox) from suspending the 
        // Web Audio API when the tab is hidden, which ALSO prevents Web Worker throttling!
        const wakeLockOsc = audioCtx.createOscillator();
        const wakeLockGain = audioCtx.createGain();
        wakeLockGain.gain.value = 1e-8; // Virtually silent, but non-zero to prevent browser optimization
        wakeLockOsc.connect(wakeLockGain);
        wakeLockGain.connect(audioCtx.destination);
        wakeLockOsc.start();

        const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        if (wakeLock === null) requestWakeLock();

        masterGain = audioCtx.createGain();
        masterGain.gain.value = parseFloat(document.getElementById('masterVol')?.value || 1.0);

        if (!metronomeGain) {
            metronomeGain = audioCtx.createGain();
            // Route strictly to the destination to bypass the Master Recorder bounce!
            metronomeGain.connect(audioCtx.destination); 
        }

        // Set up the VU Meter Analyser PRE-LIMITER to show true mix volume
        window.analyser = audioCtx.createAnalyser();
        window.analyser.fftSize = 2048;
        masterGain.connect(window.analyser);

        // SMART COMPRESSOR
        compressor = audioCtx.createDynamicsCompressor();
        let initComp = parseFloat(document.getElementById('busComp')?.value || 40);
        compressor.threshold.value = isMobileDevice ? -15.0 : -4.0 - (initComp / 100 * 16);
        compressor.ratio.value = 1 + (initComp / 100 * 11);
        compressor.knee.value = 10.0;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.05;

        // ABSOLUTE CEILING: Master Limiter
        safetyClipper = audioCtx.createWaveShaper();
        safetyClipper.oversample = 'none';
        updateSafetyCurve(document.getElementById('limiterMode')?.value || 'brickwall');

        // Route: Master Fader -> Compressor -> Safety Clipper -> Speakers
        masterGain.connect(compressor);
        compressor.connect(safetyClipper);
        safetyClipper.connect(audioCtx.destination);

        // Master Recording Tap (Records the limited, safe audio)
        window.mediaStreamDest = audioCtx.createMediaStreamDestination();
        safetyClipper.connect(window.mediaStreamDest);

        // Compile and load the AudioWorklet in the background exactly once
        if (!workletPromise) {
            // Encode as a Data URI to bypass Chrome's Service Worker Blob-interception bug
            const dataUrl = "data:application/javascript;charset=utf-8," + encodeURIComponent(recorderWorkletCode);
            workletPromise = audioCtx.audioWorklet.addModule(dataUrl);
        }

        requestAnimationFrame(renderVisuals); // starts the graphics loop with a valid timestamp

        // === 2. MASTER 3-BAND EQ ===
        masterEqIn = audioCtx.createGain();
        eqLow = audioCtx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 250;
        eqMid = audioCtx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 0.7;
        eqHigh = audioCtx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 4000;

        masterEqIn.connect(eqLow);
        eqLow.connect(eqMid);
        eqMid.connect(eqHigh);
        eqHigh.connect(masterGain);

        // === 3. MIXER SUB-BUSES ===
        synthGain = audioCtx.createGain();
        synthGain.gain.value = parseFloat(document.getElementById('synthVol')?.value || 1.0);

        drumGain = audioCtx.createGain();
        drumGain.gain.value = parseFloat(document.getElementById('drumVol')?.value || 1.0);
        drumGain.connect(masterEqIn);

        // Looper Per-Track Faders & Aux Sends
        for (let i = 0; i < 8; i++) {
            let g = audioCtx.createGain();
            g.gain.value = parseFloat(document.querySelector(`.track-vol[data-track="${i}"]`)?.value || 1.0);
            looperGainNodes.push(g);

            let p = audioCtx.createStereoPanner();
            p.pan.value = parseFloat(document.querySelector(`.pan-slider[data-track="${i}"]`)?.value || 0.0);
            looperPanners.push(p);

            g.connect(p);
            // DYNAMIC BUS ROUTING
            if (studio.trackTypes[i] === 'drum') p.connect(drumGain);
            else p.connect(synthGain);

             let eSend = audioCtx.createGain();
            eSend.gain.value = parseFloat(document.querySelector(`.echo-send[data-track="${i}"]`)?.value || 0);
            g.connect(eSend);
            looperEchoSends.push(eSend);

            let rSend = audioCtx.createGain();
            rSend.gain.value = parseFloat(document.querySelector(`.reverb-send[data-track="${i}"]`)?.value || 0);
            g.connect(rSend); looperReverbSends.push(rSend);
        }

        // Arranger Per-Track Faders & Aux Sends
        for (let i = 0; i < currentArrangerTrackCount; i++) {
            let g = audioCtx.createGain();
            g.gain.value = parseFloat(document.querySelector(`.track-vol[data-track="${i + 8}"]`)?.value || 1.0);
            linearGainNodes.push(g);

            let p = audioCtx.createStereoPanner();
            p.pan.value = parseFloat(document.querySelector(`.pan-slider[data-track="${i + 8}"]`)?.value || 0.0);
            linearPanners.push(p);

            g.connect(p);
            // DYNAMIC BUS ROUTING
            if (studio.trackTypes[i + 8] === 'drum') p.connect(drumGain);
            else p.connect(synthGain);

            let eSend = audioCtx.createGain();
            eSend.gain.value = parseFloat(document.querySelector(`.echo-send[data-track="${i + 8}"]`)?.value || 0);
            g.connect(eSend); linearEchoSends.push(eSend);

            let rSend = audioCtx.createGain();
            rSend.gain.value = parseFloat(document.querySelector(`.reverb-send[data-track="${i + 8}"]`)?.value || 0);
            g.connect(rSend); linearReverbSends.push(rSend);
        }

        // === 4. SYNTH FX CHAIN ===
        const bufferSize = audioCtx.sampleRate * 2;
        sharedNoiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = sharedNoiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        // --- RESTORED SYNTH PANNER ---
        // We still need this for the Auto-Pan effect!
        masterSynthPanner = audioCtx.createStereoPanner();
        synthGain.connect(masterSynthPanner);
        masterSynthPanner.connect(masterEqIn); // Dry synth bus goes straight to Master EQ

        if (isMobileDevice) {
            // Cheap, CPU-friendly Algorithmic Spring Reverb for Mobile
            convolver = audioCtx.createDelay(0.1);
            convolver.delayTime.value = 0.04;
            const revFeedback = audioCtx.createGain(); revFeedback.gain.value = 0.65;
            const revFilter = audioCtx.createBiquadFilter(); revFilter.type = 'lowpass'; revFilter.frequency.value = 4000;

            convolver.connect(revFilter);
            revFilter.connect(revFeedback);
            revFeedback.connect(convolver);

            convolver.connect(masterEqIn);
        } else {
            // Studio-Grade Convolution Reverb for Desktop
            convolver = audioCtx.createConvolver();
            convolver.buffer = createImpulseResponse(audioCtx, 2.5, 3.0);
            
            convolver.connect(masterEqIn);
        }

        // SMART DISTORTION
        preDistortionGain = audioCtx.createGain();
        preDistortionGain.gain.value = 0.8;
        distortionNode = audioCtx.createWaveShaper();
        distortionNode.curve = makeDistortionCurve(typeof currentDistortion !== 'undefined' ? currentDistortion : 0);
        distortionNode.oversample = isMobileDevice ? ((typeof currentDistortion !== 'undefined' && currentDistortion > 0) ? '2x' : 'none') : '4x';

        preDistortionGain.connect(distortionNode);
        distortionNode.connect(synthGain); // Distortion feeds into the Synth channel

        // GLOBAL LFO ENGINE
        buildLfoChain();

        // Panning remains a post-synth global stereo effect
        if (!lfoPanGain) lfoPanGain = audioCtx.createGain();
        lfoPanGain.gain.value = currentAutoPan || 0;
        globalLfoOutput.connect(lfoPanGain);
        lfoPanGain.connect(masterSynthPanner.pan);

        // ECHO / DELAY
        delayNode = audioCtx.createDelay(); delayNode.delayTime.value = 0.3;
        feedbackGain = audioCtx.createGain(); feedbackGain.gain.value = 0.3;
        
        // 1. The Master Delay Return is now permanently open at 100% volume
        delayMix = audioCtx.createGain(); 
        delayMix.gain.value = 1.0; 

        delayNode.connect(feedbackGain);
        feedbackGain.connect(delayNode);
        delayNode.connect(delayMix);
        delayMix.connect(masterEqIn); 

        // 2. The Synth gets its own dedicated Send knob, instead of choking the master return!
        window.synthEchoSendNode = audioCtx.createGain();
        window.synthEchoSendNode.gain.value = typeof currentEcho !== 'undefined' ? currentEcho : 0.12;
        
        masterSynthPanner.connect(window.synthEchoSendNode);
        window.synthEchoSendNode.connect(delayNode);

        // Connect Aux Sends to Master FX
        for (let i = 0; i < 8; i++) {
            if (looperEchoSends[i]) looperEchoSends[i].connect(delayNode);
            if (looperReverbSends[i]) looperReverbSends[i].connect(convolver);
            
            // Wire up the Arranger tracks!
            if (linearEchoSends[i]) linearEchoSends[i].connect(delayNode);
            if (linearReverbSends[i]) linearReverbSends[i].connect(convolver);
        }

        if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
            audioCtx.resume().catch(e => console.warn(e));
        }
    }

    const playingMidiNotes = new Set();

    let highlightUpdatePending = false;
    let previousHighlightState = "";
    let cachedGridNodes = null; // RAM Cache for Chrome
    let cachedTextNodes = null;

    function updateHighlights() {
        if (highlightUpdatePending) return;
        highlightUpdatePending = true;

        requestAnimationFrame(() => {
            highlightUpdatePending = false;
            playingMidiNotes.clear();
            pianoExtensionNotes.clear();
            const now = audioCtx ? audioCtx.currentTime : 0;

            let isStemPlaying = false;
            activeNodes.forEach((nodeData) => {
                if (nodeData.type === 'stem') { 
                    isStemPlaying = true;
                }
                else if (nodeData.type === 'arp') { nodeData.voices.forEach(v => { if (now >= v.startTime && now < v.startTime + nodeData.stepDuration) { playingMidiNotes.add(v.midiNote); } }); }
                else if (nodeData.voices) { nodeData.voices.forEach(v => playingMidiNotes.add(v.midiNote)); }
                else if (nodeData.freqs && nodeData.freqs.length > 0) { 
                    nodeData.freqs.forEach(freq => playingMidiNotes.add(Math.round(12 * Math.log2(freq / masterTune) + 69))); 
                }
            });

            midiActiveNotes.forEach((velocities, midiNote) => { playingMidiNotes.add(midiNote); });

            // Run the Harmonic Engine FIRST so we have the freshest context!
            if (typeof updateHarmonicEngine === 'function') {
                updateHarmonicEngine();
            }

            // ALWAYS UPDATE PIANO (Physical Feedback)
            updatePianoVisuals();

            // Skip the heavy Tonnetz grid math during fast slides!
            if (isGlissando) return;

            // --- NEW: SVG RENDERING CULLING ---
            const pr = document.getElementById('piano-roll-overlay');
            if (pr && pr.classList.contains('active')) {
                const prRect = pr.getBoundingClientRect();
                const coverageRatio = prRect.height / window.innerHeight;
            
                // Rule: If PR covers 80% or more, completely skip rendering the Tonnetz
                if (coverageRatio >= 0.8) {
                    return; // Exit the frame immediately (Massive CPU savings!)
                }
            }

            // --- HEAVY TONNETZ LOGIC BELOW ---
            // Track Pitch Classes (0-11) for octave-immune matching
            const playingPitchClasses = new Set();
            playingMidiNotes.forEach(note => playingPitchClasses.add(((note % 12) + 12) % 12));

            const currentStateStr = Array.from(playingMidiNotes).sort().join(',') + "|" + showExtensions + "|" + showChordDegrees;
            if (currentStateStr === previousHighlightState) return;
            previousHighlightState = currentStateStr;

            const activeElements = new Set();
            const inversionElements = new Set(); 
            const ghostElements = new Set(); // NEW: For Faint Dyad/Ambiguity Matches
            const extensionsToHighlight = new Set();
            const extensionPitchClasses = new Set();

            if (!cachedGridNodes) cachedGridNodes = document.querySelectorAll('.highlightable:not(.piano-key)');

            for (let i = 0; i < cachedGridNodes.length; i++) {
                let el = cachedGridNodes[i]; if (!el._st || el._st.length === 0) continue;
                
                let mappedNotes = snapStArray(el._st).map(st => { 
                    let f = getFreqFromSt(st); 
                    if (isOctUpOn()) f *= 2; 
                    if (isOctDownOn()) f *= 0.5; 
                    return Math.round(12 * Math.log2(f / masterTune) + 69); 
                });

                let isCoF = el.closest('#cof-overlay') !== null;
                
                // 1. EXACT MATCH (Yellow)
                let isExactMatch = isCoF ? mappedNotes.every(m => playingPitchClasses.has(((m % 12) + 12) % 12)) : mappedNotes.every(m => playingMidiNotes.has(m));
                
                let isPitchClassMatch = false;
                let isGhostDyad = false;

                // 2. PITCH CLASS & DYAD HYBRID LOGIC (Cyan)
                if (!isCoF && el._st.length >= 3) {
                    let matchCount = 0;
                    mappedNotes.forEach(m => {
                        if (playingPitchClasses.has(((m % 12) + 12) % 12)) matchCount++;
                    });

                    // Full Chord Inversion
                    if (matchCount === el._st.length && playingPitchClasses.size >= 3) {
                        isPitchClassMatch = true;
                    } 
                    // Option 3 Hybrid: "no5" Dyad Match
                    else if (matchCount === 2 && playingPitchClasses.size === 2) {
                        // Mapped notes index 0 is always the root of the geometric triad
                        const triRootPC = ((mappedNotes[0] % 12) + 12) % 12; 
                        
                        // Ask the Harmonic Engine if it knows what this dyad is supposed to be!
                        if (currentIdentifiedRootPC !== null && currentIdentifiedRootPC === triRootPC) {
                            isPitchClassMatch = true; // Mind-Reading Confident Match (Bright Cyan)
                        } else {
                            isGhostDyad = true; // Ambiguous Fallback (Faint Cyan)
                        }
                    }
                }

                if (isExactMatch) {
                    activeElements.add(el);
                    if (showExtensions && mappedNotes.length >= 3) {
                        const rootMidi = mappedNotes[0]; const isMajor = el._st.includes(el._st[0] + 4); const seventhMidi = rootMidi + (isMajor ? 11 : 10); const ninthMidi = rootMidi + 14;
                        pianoExtensionNotes.add(seventhMidi); pianoExtensionNotes.add(ninthMidi);
                        extensionsToHighlight.add(seventhMidi); extensionsToHighlight.add(ninthMidi);
                        extensionPitchClasses.add(((seventhMidi % 12) + 12) % 12);
                        extensionPitchClasses.add(((ninthMidi % 12) + 12) % 12);
                    }
                } else if (isPitchClassMatch) {
                    inversionElements.add(el);
                } else if (isGhostDyad) {
                    ghostElements.add(el);
                }
            }

            for (let i = 0; i < cachedGridNodes.length; i++) {
                let el = cachedGridNodes[i]; 
                const shouldBeActive = activeElements.has(el); 
                const shouldBeInversion = inversionElements.has(el);
                const shouldBeGhost = ghostElements.has(el);
                
                const isActive = el._isActiveState === true;
                const isInversion = el._isInversionState === true;
                const isGhost = el._isGhostState === true;

                if (el._highlightEl) {
                    // State 1: EXACT MATCH (Yellow)
                    if (shouldBeActive && !isActive) { 
                        el._isActiveState = true; el._isInversionState = false; el._isGhostState = false;
                        el._highlightEl.classList.remove('inversion-highlight', 'ghost-highlight');
                        el._highlightEl.classList.add(el._activeClass); 
                        el._highlightEl.style.opacity = '1'; 
                    }
                    // State 2: INVERSION MATCH (Bright Cyan)
                    else if (shouldBeInversion && !isInversion && !shouldBeActive) {
                        el._isInversionState = true; el._isActiveState = false; el._isGhostState = false;
                        el._highlightEl.classList.remove(el._activeClass, 'ghost-highlight');
                        el._highlightEl.classList.add('inversion-highlight');
                        el._highlightEl.style.opacity = '1';
                    }
                    // State 3: GHOST DYAD (Faint Cyan)
                    else if (shouldBeGhost && !isGhost && !shouldBeActive && !shouldBeInversion) {
                        el._isGhostState = true; el._isActiveState = false; el._isInversionState = false;
                        el._highlightEl.classList.remove(el._activeClass, 'inversion-highlight');
                        el._highlightEl.classList.add('ghost-highlight');
                        el._highlightEl.style.opacity = '1';
                    }
                    // State 4: OFF (Fade out)
                    else if (!shouldBeActive && !shouldBeInversion && !shouldBeGhost && (isActive || isInversion || isGhost)) { 
                        el._isActiveState = false; el._isInversionState = false; el._isGhostState = false;
                        el._highlightEl.classList.remove(el._activeClass, 'inversion-highlight', 'ghost-highlight'); 
                        if (!el._isExtState) el._highlightEl.style.opacity = '0'; 
                    }

                    // --- Process Extensions (7ths/9ths) ---
                    if (el._st && el._st.length === 1) {
                        let extMidi = Math.round(12 * Math.log2(getFreqFromSt(snapStArray([el._st[0]])[0]) / masterTune) + 69);
                        if (isOctUpOn()) extMidi += 12; if (isOctDownOn()) extMidi -= 12;

                        let isCoF = el.closest('#cof-overlay') !== null;
                        const shouldBeExt = isCoF ? extensionPitchClasses.has(((extMidi % 12) + 12) % 12) : extensionsToHighlight.has(extMidi);
                        const isExt = el._isExtState === true;

                        if (shouldBeExt && !isExt) { el._isExtState = true; el._highlightEl.classList.add('extension-highlight'); el._highlightEl.style.opacity = '1'; }
                        else if (!shouldBeExt && isExt) { el._isExtState = false; el._highlightEl.classList.remove('extension-highlight'); if (!el._isActiveState && !el._isInversionState && !el._isGhostState) el._highlightEl.style.opacity = '0'; }
                    }
                }
            }

            updatePianoVisuals(); // Final sweep to render any missed extensions

            // --- HARMONIC HEATMAP TRIGGER ---
            if (isHeatmapActive) {
                const activeEngineNotes = Array.from(noteMemoryMap.keys()).sort();
                const currentNotesStr = activeEngineNotes.join(',');
                if (heatmapBaseNotes.join(',') !== currentNotesStr) {
                    heatmapBaseNotes = activeEngineNotes;
                    setTimeout(updateHarmonicHeatmap, 0);
                }
            }
        });
    }

    const chordDict = {
        // Triads
        '0,4,7': '', '0,3,7': '-', '0,3,6': 'dim', '0,4,8': 'aug', '0,5,7': 'sus4', '0,2,7': 'sus2', '0,4,6': 'b5',

        // Added Tones (No 7th)
        '0,1,4,7': '(add ♭9)', '0,2,4,7': 'add9', '0,3,4,7': '(add ♯9)', '0,4,5,7': 'add11', '0,4,6,7': '(add ♯11)', '0,4,7,8': '(add ♭13)',
        '0,1,3,7': '-(add ♭9)', '0,2,3,7': '-add9', '0,3,5,7': '-add11', '0,3,6,7': '-(add ♯11)', '0,3,7,8': '-(add ♭13)',

        // 6ths
        '0,4,7,9': '6', '0,3,7,9': '-6', '0,2,4,7,9': '6/9', '0,2,3,7,9': '-6/9',

        // 7ths
        '0,4,7,11': 'maj7', '0,3,7,10': '-7', '0,4,7,10': '7', '0,3,6,10': '-7♭5', '0,3,6,9': 'dim7',
        '0,3,7,11': '-(maj7)', '0,4,8,10': 'aug7', '0,4,8,11': 'maj7♯5', '0,4,6,10': '7♭5', '0,5,7,10': '7sus4',

        // 9ths
        '0,2,4,7,11': 'maj9', '0,2,3,7,10': '-9', '0,2,4,7,10': '9', '0,1,4,7,10': '7♭9', '0,3,4,7,10': '7♯9',
        '0,2,3,6,10': '-9♭5', '0,1,3,6,10': '-7♭5♭9', '0,2,4,8,10': '9♯5', '0,1,4,8,10': '7♭9♯5', '0,3,4,8,10': '7♯9♯5', '0,2,4,6,10': '9♭5',
        '0,1,4,6,10': '7♭9♭5', '0,3,4,6,10': '7♯9♭5',
        '0,1,3,7,10': '-7♭9', '0,2,3,7,11': '-9(maj7)',
        '0,1,4,7,11': 'maj7♭9', '0,3,4,7,11': 'maj7♯9',

        // 11ths
        '0,2,4,5,7,11': 'maj11', '0,2,3,5,7,10': '-11', '0,2,4,5,7,10': '11', '0,4,6,7,10': '7♯11', '0,2,4,6,7,10': '9♯11', '0,2,4,6,7,11': 'maj9♯11',
        '0,4,5,7,10': '11(no9)', '0,4,5,7,11': 'maj11(no9)', '0,3,5,7,10': '-11(no9)', '0,4,6,7,11': 'maj7♯11',
        '0,3,6,7,10': '-7♯11', '0,3,5,7,11': '-11(maj7)',

        // 13ths
        '0,2,4,7,9,11': 'maj13', '0,2,3,5,7,9,10': '-13', '0,2,4,7,9,10': '13', '0,4,7,8,10': '7♭13', '0,2,4,7,8,10': '9♭13',
        '0,2,3,7,9,10': '-13(no11)', '0,4,7,9,10': '13(no9)', '0,4,7,9,11': 'maj13(no9)',
        '0,3,7,8,10': '-7♭13', '0,4,7,8,11': 'maj7♭13',

        // Altered Dominant Combinations
        '0,1,4,7,8,10': '7♭9♭13', '0,3,4,7,8,10': '7♯9♭13', '0,1,4,6,7,10': '7♭9♯11', '0,3,4,6,7,10': '7♯9♯11',

        // Omitted 5ths (Generated via Tonnetz spacing or intentional skipping)
        '0,4,10': '7(no5)', '0,3,10': '-7(no5)', '0,4,11': 'maj7(no5)', '0,2,4,10': '9(no5)', '0,2,3,10': '-9(no5)', '0,2,4,11': 'maj9(no5)',
        '0,1,4,10': '7♭9(no5)', '0,3,4,10': '7♯9(no5)',

        // Power chord
        '0,7': '5',

        // DYADS
        '0,4': '(no5)',     // Major 3rd dyad
        '0,3': '-(no5)',    // Minor 3rd dyad
        '0,5': 'sus4(no5)', // Perfect 4th dyad
        '0,2': 'sus2(no5)', // Major 2nd dyad
        '0,6': '(b5, no3)'  // Tritone dyad
    };

    // ==========================================
    // --- STAGE 3: THE "DUMB" UI RENDERER ---
    // ==========================================
    function updateChordDisplayUI(chordString, opacity) {
        const display = document.getElementById('chord-display');
        if (!display) return;
        
        display.textContent = chordString;
        display.style.opacity = opacity.toString();
    }

    // ==========================================
    // --- STAGE 1 & 2: THE HARMONIC ENGINE ---
    // ==========================================
    function updateHarmonicEngine() {
        const now = audioCtx ? audioCtx.currentTime : performance.now() / 1000;
        const memoryWindowSecs = (60 / currentArpBPM) * 1.5; 
        const sustainActive = typeof isSustainOn === 'function' ? isSustainOn() : false;

        // --- 1. MEMORY: Sync & Leaky Bucket ---
        if (typeof playingMidiNotes !== 'undefined') {
            playingMidiNotes.forEach(note => {
                if (!noteMemoryMap.has(note)) {
                    noteMemoryMap.set(note, { addedTime: now, isHeld: true, releaseTime: null });
                } else {
                    let data = noteMemoryMap.get(note);
                    data.isHeld = true;
                    data.releaseTime = null;
                }
            });
        }

        const passingToneThreshold = Math.max(0.04, Math.min(0.11, (15 / currentArpBPM) * 0.8));

        for (let [note, data] of noteMemoryMap.entries()) {
            if (typeof playingMidiNotes !== 'undefined' && !playingMidiNotes.has(note) && data.isHeld) {
                data.isHeld = false;
                data.releaseTime = now;
                if ((data.releaseTime - data.addedTime) < passingToneThreshold) {
                    noteMemoryMap.delete(note);
                    continue; 
                }
            }
            if (!data.isHeld && !sustainActive && data.releaseTime) {
                if (now - data.releaseTime > memoryWindowSecs) {
                    noteMemoryMap.delete(note);
                }
            }
        }

        // --- SEPARATE ACTIVE VS GHOST NOTES ---
        let heldNotes = [];
        let ghostNotes = [];
        for (let [note, data] of noteMemoryMap.entries()) {
            if (data.isHeld) heldNotes.push(note);
            else ghostNotes.push(note);
        }

        if (heldNotes.length === 0 && ghostNotes.length === 0) {
            currentGravityTargets = [];
            isStrongSequence = false;
            if (typeof isStemPlaying !== 'undefined' && isStemPlaying) {
                updateChordDisplayUI("(NON-MIDI)", 0.5);
            } else {
                updateChordDisplayUI("", 0);
            }
            return;
        }

        // --- 2. THEORY: Helper function to evaluate any array of notes ---
        const evaluateNoteArray = (notesArray) => {
            if (notesArray.length === 0) return { match: null, root: 0, bass: 0, score: -1, pcs: [], minNote: 0 };
            
            let minN = Math.min(...notesArray);
            let bass = minN % 12;
            let pcs = Array.from(new Set(notesArray.map(n => n % 12)));

            let match = null;
            let root = bass;
            let score = -1;

            if (pcs.length > 1) {
                for (let testRoot of pcs) {
                    let intervals = pcs.map(pc => (pc - testRoot + 12) % 12).sort((a, b) => a - b);
                    let iStr = intervals.join(',');
                    if (chordDict[iStr] !== undefined) {
                        let currentScore = intervals.length;
                        if (testRoot === bass) currentScore += 10; // Bass bonus
                        if (currentScore > score) {
                            score = currentScore;
                            match = chordDict[iStr];
                            root = testRoot;
                        }
                    }
                }
            }
            return { match, root, bass, score, pcs, minNote: minN };
        };

        // --- THE "CLEAN BREAK" VETO LOGIC ---
        let evalHeld = evaluateNoteArray(heldNotes);
        let finalEval;
        let activeNotes;

        // If the keys currently under your fingers form a recognized chord/dyad,
        // they INSTANTLY veto all ghost notes. This stops old chords from bleeding into new ones.
        if (evalHeld.match !== null || heldNotes.length >= 3) {
            finalEval = evalHeld;
            activeNotes = heldNotes;
            
            // Aggressively purge the ghost notes so they don't corrupt future calculations
            ghostNotes.forEach(n => noteMemoryMap.delete(n));
        } else {
            // Fallback: If you are just holding 1 or 2 notes (like the end of an arpeggio),
            // blend it with the ghost notes to figure out the surrounding chord context.
            activeNotes = heldNotes.concat(ghostNotes);
            finalEval = evaluateNoteArray(activeNotes);
        }

        currentIdentifiedRootPC = finalEval.root;
        let bestMatch = finalEval.match;
        let bestRoot = finalEval.root;
        let bassPC = finalEval.bass;
        let pitchClasses = finalEval.pcs;
        let minNote = finalEval.minNote;

        // --- 3. MEMORY: FIFO Purge ---
        while (noteMemoryMap.size > CHORD_BUFFER_MAX) {
            let oldestNote = null;
            let oldestTime = Infinity;

            for (let [note, data] of noteMemoryMap.entries()) {
                // Only give immunity to notes that are CURRENTLY held. 
                // This prevents rogue ghost bass notes from getting permanently stuck in the buffer.
                const isBass = (note === minNote) && data.isHeld;
                const isRoot = (note % 12 === bestRoot) && data.isHeld;
                
                if (!isBass && !isRoot && data.addedTime < oldestTime) {
                    oldestTime = data.addedTime;
                    oldestNote = note;
                }
            }

            if (oldestNote === null) {
                for (let [note, data] of noteMemoryMap.entries()) {
                    if (data.addedTime < oldestTime) {
                        oldestTime = data.addedTime;
                        oldestNote = note;
                    }
                }
            }

            if (oldestNote !== null) {
                noteMemoryMap.delete(oldestNote);
            } else {
                break; 
            }
        }

        // --- 4. THEORY: History & Gravity ---
        let chordNameStr = "";
        currentGravityTargets = [];
        isStrongSequence = false;

        if (activeNotes.length === 1) {
            chordNameStr = ""; 
        } else if (pitchClasses.length === 1 && activeNotes.length > 1) {
            chordNameStr = ""; 
        } else if (bestMatch !== null) {
            if (rootHistory.length === 0 || rootHistory[0] !== bestRoot) {
                rootHistory.unshift(bestRoot);
                if (rootHistory.length > 5) rootHistory.pop();
            }

            chordNameStr = labelAbsoluteSharp[bestRoot] + bestMatch;
            if (bestRoot !== bassPC) chordNameStr += `/${labelAbsoluteSharp[bassPC]}`;

            // Functional Gravity Engine
            const isMajor = bestMatch === '' || bestMatch === 'maj' || bestMatch === '6' || bestMatch.includes('add');
            const isMinor = bestMatch.startsWith('-');
            const isDominant = (bestMatch.includes('7') || bestMatch.includes('9') || bestMatch.includes('13'))
                && !bestMatch.includes('maj') && !isMinor && !bestMatch.includes('dim');
            const isDiminished = bestMatch.includes('dim') || bestMatch.includes('b5');
            const isAugmented = bestMatch.includes('aug');
            const isSus = bestMatch.includes('sus');

            if (isDominant) {
                currentGravityTargets.push((bestRoot - 7 + 12) % 12, (bestRoot - 1 + 12) % 12);
            } else if (isDiminished) {
                currentGravityTargets.push((bestRoot + 1) % 12);
            } else if (isAugmented) {
                currentGravityTargets.push((bestRoot - 7 + 12) % 12);
            } else if (isSus) {
                currentGravityTargets.push(bestRoot);
            }

            if (rootHistory.length > 1) {
                const recentRoots = [rootHistory[1]];
                if (rootHistory.length > 2) recentRoots.push(rootHistory[2]);

                recentRoots.forEach(prevRoot => {
                    if (isMajor || isDominant) {
                        const targetI = (bestRoot - 7 + 12) % 12;
                        if ([2, 5, 9, 8].map(int => (targetI + int) % 12).includes(prevRoot)) {
                            if (!currentGravityTargets.includes(targetI)) currentGravityTargets.push(targetI);
                            isStrongSequence = true;
                            const targetVi = (targetI + 9) % 12;
                            if (!currentGravityTargets.includes(targetVi)) currentGravityTargets.push(targetVi);
                        }
                        const targetI_Backdoor = (bestRoot + 2) % 12;
                        if (prevRoot === (bestRoot - 2 + 12) % 12) {
                            if (!currentGravityTargets.includes(targetI_Backdoor)) currentGravityTargets.push(targetI_Backdoor);
                            isStrongSequence = true;
                        }
                    }
                    if (isMajor || isMinor) {
                        const targetI = (bestRoot - 5 + 12) % 12;
                        if ([0, 7, 10].map(int => (targetI + int) % 12).includes(prevRoot)) {
                            if (!currentGravityTargets.includes(targetI)) currentGravityTargets.push(targetI);
                            isStrongSequence = true;
                        }
                    }
                });
            }
        } else {
            // Fallback for unknown clusters
            let intervals = pitchClasses.map(pc => (pc - bassPC + 12) % 12).sort((a, b) => a - b);
            chordNameStr = `${labelAbsoluteSharp[bassPC]} (${intervals.length})`;
        }

        // --- 5. RENDER ---
        updateChordDisplayUI(chordNameStr, 1);
    }

    function spawnVoice(freq, startTime, index, totalNotes, isChord, synthState = null, destination = null, noteVel = null) {
        const midiNote = Math.round(12 * Math.log2(freq / masterTune) + 69);

        globalStaggerCounter = (globalStaggerCounter + 1) % 6; 
    
        // 1. RANDOMIZED STAGGERING (Breaks static phase alignment)
        const jitter = Math.random() * 0.0015;
        const stagger = isChord ? (index * 0.002) + jitter : (globalStaggerCounter * 0.002) + jitter;
    
        // 2. THREAD STALL PROTECTION (Prevents envelope snapping)
        // Guarantee the start time is at least 15ms in the future
        const safetyBuffer = Math.max(0.015, typeof currentDeclick !== 'undefined' ? currentDeclick : 0.015);
        const safeStartTime = Math.max(startTime + stagger, audioCtx.currentTime + safetyBuffer);

        if (globalVoicePool.length >= maxVoices) {
            const oldestVoice = globalVoicePool.shift();
            if (oldestVoice && oldestVoice.gainNode) {
                beginRelease([oldestVoice], true, true);
            }
        }

        // 3. CHORD & GLISSANDO VOLUME FIX
        let isAccent = false;
        if (!isChord) {
            // Prevent massive transient clipping during fast piano slides (glissandos).
            if (totalNotes === 1) {
                // Only 1 out of every 6 rapid piano notes gets the 1.4x burst
                isAccent = (globalStaggerCounter === 0); 
            } else {
                const safeTotal = totalNotes > 0 ? totalNotes : 4;
                isAccent = safeTotal === 3 ? (index % 3 === 0) : (index % safeTotal === 0);
            }
        } else {
            // Only accent the root note (index 0) of a chord. 
            isAccent = (index === 0);
        }

        const accentMult = isAccent ? 1.4 : 0.8;
    
        // Smoothly attenuate the higher voices in a chord to prevent summing clips
        const chordAttenuation = isChord ? Math.max(0.5, 1.0 - (index * 0.15)) : 1.0;

        const s = synthState || { 
            osc1: currentOsc1, osc2: currentOsc2, detune: currentDetune, osc2Mult: currentOsc2Mult, 
            subOsc: currentSubOsc, noise: currentNoise, resonance: currentResonance, brightness: currentBrightness, 
            filterEnv: currentFilterEnv, attack: currentAttack, decay: currentDecay, sustain: currentSustain, 
            release: currentRelease, oscMix: currentOscMix, glide: currentGlide, filterType: currentFilterType, 
            sampleRootKey: typeof currentSampleRootKey !== 'undefined' ? currentSampleRootKey : 60,
            instrumentPreset: document.getElementById('instrumentPreset')?.value || 'piano',
            osc2Pitch: typeof currentOsc2Pitch !== 'undefined' ? currentOsc2Pitch : 0,
            sampleStart: typeof currentSampleStart !== 'undefined' ? currentSampleStart : 0,
            modWheel: typeof currentModWheel !== 'undefined' ? currentModWheel : 0
        };

        const osc1Gain = audioCtx.createGain();
        const osc2Gain = audioCtx.createGain();
        let osc1 = null;
        let osc2 = null;
        let sampleSource = null;
        let overtoneOsc = null;
        let overtoneGain = null;

        const effectiveGlideTime = isGlidePadOn() ? Math.max(0.15, s.glide) : s.glide;
        const isLegato = activeUserNotes > 1 || sustainedVoices.size > 0;
        const shouldGlide = lastPlayedFreq && effectiveGlideTime > 0 && (s.glideMode === 'always' || (s.glideMode === 'legato' && isLegato) || isGlidePadOn());

        // --- STRICT MULTI-TRACK ROUTING ---
        const inst = s.instrumentPreset || 'piano';
        const isTrackSampler = inst.startsWith('sample_');
        let targetBuffer = null;

        if (isTrackSampler && typeof sampleBank !== 'undefined') {
            if (sampleBank.has(inst)) {
                targetBuffer = sampleBank.get(inst);
            } else {
                const cleanName = inst.replace('sample_folder:', '').replace('sample_db:', '');
                if (sampleBank.has(`sample_folder:${cleanName}`)) {
                    targetBuffer = sampleBank.get(`sample_folder:${cleanName}`);
                } else if (sampleBank.has(`sample_db:${cleanName}`)) {
                    targetBuffer = sampleBank.get(`sample_db:${cleanName}`);
                } else {
                    // THE FIX: Extension-Agnostic Fallback (e.g. if JSON asked for .flac but RAM only has .wav)
                    const baseName = cleanName.substring(0, cleanName.lastIndexOf('.')) || cleanName;
                    const keys = Array.from(sampleBank.keys());
                    const match = keys.find(k => (k.startsWith('sample_db:') || k.startsWith('sample_folder:')) && k.includes(baseName));
                    
                    if (match) {
                        targetBuffer = sampleBank.get(match);
                    } else {
                        // Only log if the engine completely fails to find the audio data!
                        console.warn(`Audio Engine: Failed to locate sample '${inst}' in RAM.`);
                        if (typeof loadSampleToBuffer === 'function' && inst.startsWith('sample_folder:')) {
                            loadSampleToBuffer(inst, cleanName);
                        }
                    }
                }
            }
        }

        if (isTrackSampler) {
            if (targetBuffer) {
                sampleSource = audioCtx.createBufferSource();
                sampleSource.buffer = targetBuffer;
                sampleSource.loop = true; // Legacy checks removed

                const rootMidi = s.sampleRootKey !== undefined ? s.sampleRootKey : 60;
                const baseFreq = 440.0 * Math.pow(2, (rootMidi - 69) / 12);
                const targetRate = freq / baseFreq;

                if (shouldGlide) {
                    const lastRate = lastPlayedFreq / baseFreq;
                    sampleSource.playbackRate.setValueAtTime(lastRate, safeStartTime);
                    sampleSource.playbackRate.exponentialRampToValueAtTime(targetRate, safeStartTime + effectiveGlideTime);
                } else {
                    sampleSource.playbackRate.value = targetRate;
                }

                osc1Gain.gain.value = 1.0;
                osc2Gain.gain.value = 0.0;
                sampleSource.connect(osc1Gain);
            } else {
                // Buffer hasn't loaded yet, or filename is missing. Stay silent!
                osc1Gain.gain.value = 0.0;
                osc2Gain.gain.value = 0.0;
            }
        } else {
            // Analog Synth Generation
            osc1 = audioCtx.createOscillator();
            osc2 = audioCtx.createOscillator();
            
            osc1.type = s.osc1;
            osc2.type = s.osc2;

            if (s.overtones > 0) {
                const customWave = getOrCreateAcousticWave(s.overtones);
                if (customWave) {
                    overtoneOsc = audioCtx.createOscillator();
                    overtoneOsc.setPeriodicWave(customWave);
                    overtoneOsc.frequency.value = freq;

                    overtoneGain = audioCtx.createGain();
                    // Scale the volume so it acts as a subtle resonance layer
                    overtoneGain.gain.value = s.overtones * 0.3;

                    overtoneOsc.connect(overtoneGain);
                    overtoneOsc.start(safeStartTime);
                }
            }

            // 1. Grab the preset's core harmonic multiplier (e.g., 2.0 for an octave)
            const baseOsc2Mult = s.osc2Mult !== undefined ? s.osc2Mult : (typeof currentOsc2Mult !== 'undefined' ? currentOsc2Mult : 1);
        
            // 2. Grab the user's manual slider pitch shift (e.g., 7 semitones)
            const o2p = s.osc2Pitch !== undefined ? s.osc2Pitch : (typeof currentOsc2Pitch !== 'undefined' ? currentOsc2Pitch : 0);
            const pitchOsc2Mult = Math.pow(2, o2p / 12.0); 
        
            // 3. Combine them all: (Base Freq) * (Detune Drift) * (Preset Harmony) * (User Shift)
            const targetFreq2 = freq * Math.pow(2, s.detune / 1200) * baseOsc2Mult * pitchOsc2Mult;

            if (shouldGlide) {
                osc1.frequency.setValueAtTime(lastPlayedFreq, safeStartTime);
                osc1.frequency.exponentialRampToValueAtTime(freq, safeStartTime + effectiveGlideTime);
                osc2.frequency.setValueAtTime(lastPlayedFreq * s.osc2Mult, safeStartTime);
                osc2.frequency.exponentialRampToValueAtTime(targetFreq2, safeStartTime + effectiveGlideTime);
            } else {
                osc1.frequency.value = freq; osc2.frequency.value = targetFreq2;
            }

            osc1Gain.gain.value = 1.0 - s.oscMix; osc2Gain.gain.value = s.oscMix;
            osc1.connect(osc1Gain); osc2.connect(osc2Gain);
        }

        lastPlayedFreq = freq;

        let subOsc = null; let subGain = null;
        if (s.subOsc > 0 && !isTrackSampler) { 
            subOsc = audioCtx.createOscillator(); subOsc.type = 'sine'; subOsc.frequency.value = freq / 2;
            subGain = audioCtx.createGain(); subGain.gain.value = s.subOsc;
        }

        let noiseSrc = null; let noiseGain = null;
        if (s.noise > 0 && sharedNoiseBuffer && !isTrackSampler) {
            noiseSrc = audioCtx.createBufferSource(); noiseSrc.buffer = sharedNoiseBuffer; noiseSrc.loop = true;
            noiseGain = audioCtx.createGain(); noiseGain.gain.value = s.noise;
        }

        const filter = audioCtx.createBiquadFilter(); filter.type = s.filterType;
        filter.channelCount = 2; filter.channelCountMode = 'explicit'; 
        filter.Q.value = s.resonance;
        
        const targetBaseCutoff = Math.min(freq * s.brightness, 12000);
        const baseCutoff = dampenHeld ? 600 : targetBaseCutoff;
    
        // --- MOD WHEEL SEQUENCER FIX (Filter) ---
        const modVal = s.modWheel !== undefined ? s.modWheel : (typeof currentModWheel !== 'undefined' ? currentModWheel : 0);
        const macroCutoff = Math.min(20000, baseCutoff * (1 + (modVal * 3)));
    
        filter.frequency.value = macroCutoff; 
        filter.frequency.setValueAtTime(macroCutoff, audioCtx.currentTime);
        filter.frequency.setValueAtTime(macroCutoff, safeStartTime);

        if (s.filterEnv !== 0 && !dampenHeld) {
            // The envelope now scales dynamically on top of the mod wheel's pushed cutoff!
            const peakCutoff = s.filterEnv > 0 ? Math.min(macroCutoff * (1 + s.filterEnv), 20000) : Math.max(macroCutoff * (1 + s.filterEnv), 50);
            const safeFilterAttack = Math.max(0.025, Math.max(currentDeclick, s.attack * 0.5));
            filter.frequency.exponentialRampToValueAtTime(peakCutoff, safeStartTime + safeFilterAttack);
            filter.frequency.exponentialRampToValueAtTime(Math.max(0.001, macroCutoff), safeStartTime + safeFilterAttack + s.decay);
        }

        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0; 
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0, safeStartTime);
        const releaseGain = audioCtx.createGain();
        releaseGain.gain.value = 1.0;

        let ampLfoGain = audioCtx.createGain(); ampLfoGain.gain.value = 1.0;

        const voiceLfoEnv = audioCtx.createGain();
        const delayEnd = safeStartTime + (s.lfoDelay || 0);

        voiceLfoEnv.gain.setValueAtTime(0, safeStartTime);
        voiceLfoEnv.gain.setValueAtTime(0, delayEnd);
        if (s.lfoFade > 0) {
            voiceLfoEnv.gain.linearRampToValueAtTime(1.0, delayEnd + s.lfoFade);
        } else {
            voiceLfoEnv.gain.setValueAtTime(1.0, delayEnd);
        }

        if (globalLfoOutput) globalLfoOutput.connect(voiceLfoEnv);

        const baseVibrato = s.vibrato !== undefined ? s.vibrato : (typeof currentVibrato !== 'undefined' ? currentVibrato : 0);
        const vPitchGain = audioCtx.createGain(); 
        vPitchGain.gain.value = baseVibrato + (modVal * 50); // Add up to 50 cents based on Mod Wheel

        const vFilterGain = audioCtx.createGain(); vFilterGain.gain.value = s.sweep !== undefined ? s.sweep : currentSweep;
        const vAmpGain = audioCtx.createGain(); vAmpGain.gain.value = s.tremolo !== undefined ? s.tremolo : currentTremolo;

        voiceLfoEnv.connect(vPitchGain);
        if (osc1) vPitchGain.connect(osc1.detune);
        if (osc2) vPitchGain.connect(osc2.detune);
        if (sampleSource) vPitchGain.connect(sampleSource.detune);

        voiceLfoEnv.connect(vFilterGain); vFilterGain.connect(filter.detune);
        voiceLfoEnv.connect(vAmpGain); vAmpGain.connect(ampLfoGain.gain);

        osc1Gain.connect(filter); osc2Gain.connect(filter);
        if (subOsc) { subOsc.connect(subGain); subGain.connect(filter); }
        if (noiseSrc) { noiseSrc.connect(noiseGain); noiseGain.connect(filter); }

        if (typeof overtoneGain !== 'undefined' && overtoneGain) overtoneGain.connect(filter);

        filter.connect(gainNode); 
        gainNode.connect(releaseGain);
        releaseGain.connect(ampLfoGain);

        let finalVoiceOutput = ampLfoGain;

        if (s.distortion > 0) {
            const voiceDistortion = audioCtx.createWaveShaper();
            voiceDistortion.curve = makeDistortionCurve(s.distortion);
            voiceDistortion.oversample = isMobileDevice ? '2x' : '4x';
            
            ampLfoGain.connect(voiceDistortion);
            finalVoiceOutput = voiceDistortion;
        }

        if (destination) {
            finalVoiceOutput.connect(destination); 
        } else {
            finalVoiceOutput.connect(synthGain); 
        }

        const activeVelocity = (noteVel !== null && noteVel !== undefined) ? noteVel : (typeof currentVelocity !== 'undefined' ? currentVelocity : 100);
        const velMult = activeVelocity > 1 ? activeVelocity / 127.0 : Math.max(0.01, activeVelocity);

        if (midiOutMode === 'midi') {
            gainNode.gain.setValueAtTime(0, safeStartTime);
        } else {
            // Integrate the chord attenuation into the polyphony scaler
            const polyphonyScale = Math.max(0.3, 1.0 - (globalVoicePool.length * 0.025)) * chordAttenuation;
            const baseVolume = typeof isMobileDevice !== 'undefined' && isMobileDevice ? 0.045 : 0.085;
            const peak = dampenHeld ? 0.015 : (baseVolume * accentMult * velMult * polyphonyScale);
            const sustainLevel = dampenHeld ? 0.005 : Math.max(0.001, peak * s.sustain);
        
            // Ensure the attack slope respects the thread safety buffer
            const safeAttack = Math.max(safetyBuffer, parseFloat(s.attack || 0)); 

            gainNode.gain.linearRampToValueAtTime(peak, safeStartTime + safeAttack);
            gainNode.gain.exponentialRampToValueAtTime(sustainLevel, safeStartTime + safeAttack + s.decay);
        }

        if (osc1) osc1.start(safeStartTime);
        if (osc2) osc2.start(safeStartTime);
        const sStart = s.sampleStart !== undefined ? s.sampleStart : currentSampleStart;
        if (sampleSource) sampleSource.start(safeStartTime, sStart);
        if (subOsc) subOsc.start(safeStartTime);
        if (noiseSrc) noiseSrc.start(safeStartTime);

        if (midiOut) {
            const timeToStart = Math.max(0, safeStartTime - audioCtx.currentTime);
            setTimeout(() => {
                if (midiOut) midiOut.send([0x90, midiNote, activeVelocity]);
                if (!isChord) setTimeout(() => { if (midiOut) midiOut.send([0x80, midiNote, 0]); }, 250);
            }, timeToStart * 1000);
        }

        const voiceObj = {
            osc1, osc2, sampleSource, subOsc, noiseSrc, gainNode, releaseGain,
            filter, baseCutoff, ampLfoGain, vPitchGain, vFilterGain, vAmpGain,
            voiceLfoEnv, freq, midiNote, isChord, startTime: safeStartTime, releaseTime: s.release,
            overtoneOsc, overtoneGain
        };
        globalVoicePool.push(voiceObj);
        return voiceObj;
    }

    const tunings = {
        equal: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
        just: [0, 112, 204, 316, 386, 498, 590, 702, 814, 884, 1018, 1088],
        pythagorean: [0, 90, 204, 294, 408, 498, 612, 702, 792, 906, 996, 1110]
    };

    function getFreqFromSt(st) {
        let pc = ((st % 12) + 12) % 12;
        let interval = (pc - currentKeyCenter + 12) % 12;
        let cents = tunings[currentTuning][interval];
        let detuneCents = cents - (interval * 100);
        let baseFreq = masterTune * Math.pow(2, (st - 69) / 12);
        return baseFreq * Math.pow(2, detuneCents / 1200) * Math.pow(2, currentTranspose / 12);
    }

    function snapStArray(stArray) {
        if (!snapToScale || currentScale === 'all') return stArray;
        const activeScalePCs = new Set(scaleMasks[currentScale].map(i => (currentKeyCenter + i) % 12));
        return stArray.map(st => {
            let pc = ((st % 12) + 12) % 12;
            if (activeScalePCs.has(pc)) return st;
            for (let offset of [1, -1, 2, -2]) { if (activeScalePCs.has(((pc + offset) % 12 + 12) % 12)) return st + offset; }
            return st;
        });
    }

    function applyVoiceLeading(targetFreqs) {
        if (lastPlayedMidiNotes.length === 0 || targetFreqs.length === 0) return targetFreqs;

        // 1. Get the Pitch Classes (0-11) of the chord we WANT to play
        const newPitchClasses = targetFreqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69) % 12);

        // 2. Find the "Center of Gravity" of the PREVIOUS chord
        const prevCenter = lastPlayedMidiNotes.reduce((a, b) => a + b, 0) / lastPlayedMidiNotes.length;

        // 3. For each new Pitch Class, find the exact octave that puts it closest to the previous center!
        let voicedMidiNotes = newPitchClasses.map(pc => {
            // Find the nearest instance of this Pitch Class to the previous chord's center
            let octaveOffset = Math.round((prevCenter - pc) / 12);
            return pc + (octaveOffset * 12);
        });

        // 4. Sort from lowest to highest pitch, then convert back to frequencies
        voicedMidiNotes.sort((a, b) => a - b);
        return voicedMidiNotes.map(midi => masterTune * Math.pow(2, (midi - 69) / 12));
    }

    let stepAdvanceTimeout = null; // Declare the debounce timer

    function playFrequencies(element, freqs, originalStArray = null, synthState = null, destination = null, noteVel = null) {
        initAudio();
        if (activeNodes.has(element)) return;

        // Dynamically route live playing through the selected DAW track's mixer channel!
        let activeDest = destination;
        if (!activeDest && typeof studio !== 'undefined') {
            const activeDomain = studio.lastSelectedDomain;
            const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            activeDest = activeDomain === 'looper' ? looperGainNodes[activeIdx] : linearGainNodes[activeIdx - 8];
        }

        // --- THE INVERSION STORAGE FIX ---
        // Centralize the frequency recalculation and stArray generation here!
        let finalFreqs = [...freqs];
        let storageStArray = originalStArray ? [...originalStArray] : null;

        if (originalStArray) {
            let extendedSt = getExtendedStArray(originalStArray);
            let snapped = snapStArray(extendedSt);
            finalFreqs = snapped.map(st => getFreqFromSt(st));
            
            if (isOctUpOn()) finalFreqs = finalFreqs.map(f => f * 2);
            if (isOctDownOn()) finalFreqs = finalFreqs.map(f => f * 0.5);
            if (typeof voiceLeadHeld !== 'undefined' && voiceLeadHeld) finalFreqs = applyVoiceLeading(finalFreqs);

            // Calculate the 1:1 mapped ST coordinates so sequencer playback perfectly mirrors the live octaves/inversions!
            storageStArray = finalFreqs.map((f, i) => {
                const finalMidi = Math.round(12 * Math.log2(f / masterTune) + 69);
                const baseMidi = Math.round(12 * Math.log2(getFreqFromSt(snapped[i]) / masterTune) + 69);
                return snapped[i] + (finalMidi - baseMidi);
            });
        }

        if (!element.isLooper) {
            if (activeUserNotes === 0) retriggerLFO();
            activeUserNotes++;
            if (uiHideDelay > 0) hideNav();

            if (typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
                clearTimeout(stepAdvanceTimeout);
                
                lastPlayedMidiNotes = finalFreqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));
                
                // Pass the perfectly matched storageStArray to the step sequencer!
                let createdEvts = handleStepEntry(finalFreqs, storageStArray, null, 1);
                
                const stateToUse = synthState || captureCurrentSynthState();
                const voices = finalFreqs.map((freq) => spawnVoice(freq, audioCtx.currentTime, 0, finalFreqs.length, true, stateToUse, activeDest, noteVel));

                // Save the PURE originalStArray to the node memory for safe live-retriggering
                activeNodes.set(element, { type: 'chord', freqs: finalFreqs, voices: voices, isStepPreview: true, startTime: audioCtx.currentTime, originalStArray: storageStArray || originalStArray, looperEvt: createdEvts, velocity: noteVel, destination: activeDest });
                updateHighlights();
                return;
            }
        }

        if ((looper.isArmed || arranger.isArmed) && !element.isLooper) {
            if (looper.isArmed) { looper.isArmed = false; looper.isRecording = true; looper.isPlaying = true; looper.startTime = audioCtx.currentTime; }
            if (arranger.isArmed) { arranger.isArmed = false; arranger.isRecording = true; arranger.isPlaying = true; arranger.startTime = audioCtx.currentTime; }
            metronomeBeatCount = 0; nextMetronomeTick = audioCtx.currentTime + (60 / currentArpBPM);
            playClick(audioCtx.currentTime, true);
            if (metronomeMode === 1) isMetronomePlaying = false;
            updateStudioUI();
        }

        lastPlayedMidiNotes = finalFreqs.map(f => Math.round(12 * Math.log2(f / masterTune) + 69));

        let looperEvt = null;
        if ((looper.isRecording || arranger.isRecording) && !element.isLooper) {
            // Pass the perfectly matched storageStArray to the live sequencer!
            looperEvt = recordStudioEvent(finalFreqs, 'play', storageStArray);
        }

        if (isArpOn() && finalFreqs.length > 1) {
            let arpFreqs = applyArpMode(finalFreqs);
            let stepDuration = 0;
            const beatDuration = 60 / currentArpBPM;
            if (finalFreqs.length === 3) stepDuration = currentArpRhythm === 'fast' ? (beatDuration / 3) : ((beatDuration * 2) / 3);
            else stepDuration = currentArpRhythm === 'fast' ? (beatDuration / 4) : (beatDuration / 2);
            
            // Save the PURE originalStArray to the node memory
            activeNodes.set(element, { type: 'arp', freqs: arpFreqs, stepDuration: stepDuration, nextNoteTime: audioCtx.currentTime, noteIndex: 0, voices: [], looperEvt: looperEvt, startTime: audioCtx.currentTime, originalStArray: storageStArray || originalStArray, synthState: synthState, destination: activeDest, velocity: noteVel });
            scheduleArps();
        } else {
            const voices = finalFreqs.map((freq) => spawnVoice(freq, audioCtx.currentTime, 0, finalFreqs.length, true, synthState, activeDest, noteVel));
            
            // Save the PURE originalStArray to the node memory
            activeNodes.set(element, { type: 'chord', freqs: finalFreqs, voices: voices, looperEvt: looperEvt, startTime: audioCtx.currentTime, originalStArray: storageStArray || originalStArray, synthState: synthState, destination: activeDest, velocity: noteVel });
        }
        updateHighlights();
    }

    // release audio graph nodes with automatic garbage collection
    function beginRelease(voices, skipFade = false, isFastSwipe = false) {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;

        // THE FIX: Added overtoneOsc and overtoneGain to the destructured list
        voices.forEach(({ osc1, osc2, overtoneOsc, overtoneGain, sampleSource, subOsc, noiseSrc, gainNode, releaseGain, filter, ampLfoGain, vPitchGain, vFilterGain, vAmpGain, voiceLfoEnv, midiNote, isChord, releaseTime, startTime }) => {
            try {
                const activeRelNode = releaseGain || gainNode;

                const cleanup = () => {
                    const safeStop = (n) => { try { if (n) n.stop(); } catch (e) { } };
                    const safeDisc = (n) => { try { if (n) n.disconnect(); } catch (e) { } };

                    safeStop(osc1); safeStop(osc2); safeStop(overtoneOsc); safeStop(sampleSource); safeStop(subOsc); safeStop(noiseSrc);

                    if (globalLfoOutput && voiceLfoEnv) {
                        try { globalLfoOutput.disconnect(voiceLfoEnv); } catch (e) { }
                    }

                    safeDisc(osc1); safeDisc(osc2); safeDisc(overtoneOsc); safeDisc(overtoneGain);
                    safeDisc(sampleSource); safeDisc(subOsc); safeDisc(noiseSrc);
                    safeDisc(vPitchGain); safeDisc(vFilterGain); safeDisc(vAmpGain); safeDisc(voiceLfoEnv);

                    safeDisc(filter); safeDisc(gainNode); safeDisc(releaseGain); safeDisc(ampLfoGain);
                };

                if (startTime && now <= startTime) {
                    activeRelNode.gain.setTargetAtTime(0, now, 0.005); 
                    setTimeout(cleanup, 50);
                } 

                else {
                    // STANDARD DAW RELEASE LOGIC
                    const targetRelease = releaseTime !== undefined ? releaseTime : currentRelease;
                    let relTime = dampenHeld ? Math.min(0.15, targetRelease) : targetRelease;
                    relTime = Math.max(currentDeclick, relTime);

                    if (skipFade || isFastSwipe) {
                        const fastTC = Math.max(currentDeclick, 0.015); 
                        activeRelNode.gain.setTargetAtTime(0, now, fastTC);
                        setTimeout(cleanup, fastTC * 5000); 
                    } else {
                        // Math.exp(-5) reaches 0.6% volume, preventing micro-clicks when osc.stop() hard-kills the hardware
                        const releaseTC = relTime / 5; 
                        activeRelNode.gain.setTargetAtTime(0, now, releaseTC);
                        setTimeout(cleanup, (relTime * 1000) + 100);
                    }
                }
                
                // --- EXTERNAL MIDI OFF ---
                if (midiOut && isChord) midiOut.send([0x80, midiNote, 0]);

            } catch (e) { }
        });

        // Remove the released voices from the active pool so they aren't double-released
        if (typeof globalVoicePool !== 'undefined') {
            globalVoicePool = globalVoicePool.filter(activeVoice => !voices.includes(activeVoice));
        }
    }

    function stopFrequencies(element, forceInstant = false) {
        if (!activeNodes.has(element)) return;
        const nodeData = activeNodes.get(element);
        activeNodes.delete(element);

        let finalNoteDuration = 0; // NEW: Track the exact duration for the Step Cursor

        // --- THE DYNAMIC DURATION FIX ---
        const isLiveRecording = (looper.isRecording || arranger.isRecording) && !element.isLooper;
        const isStepEntry = (typeof isStepEntryMode !== 'undefined' && isStepEntryMode);

        if (isLiveRecording || isStepEntry) {
            if (nodeData && nodeData.looperEvt) {
                let dur = Math.max(0.05, audioCtx.currentTime - nodeData.startTime);
                
                // THE FIX: Parse prSnapRes to ensure it's a number!
                const currentSnap = parseFloat(prSnapRes);

                if (isStepEntry && currentSnap > 0) {
                    const beatSecs = 60 / currentArpBPM;
                    const snapSecs = beatSecs * currentSnap;
                    // Ensures quick taps are at least 1 unit long, while holds round to the grid multiplier
                    dur = Math.max(snapSecs, Math.round(dur / snapSecs) * snapSecs);
                }

                if (Array.isArray(nodeData.looperEvt)) {
                    nodeData.looperEvt.forEach(e => e.duration = dur);
                } else {
                    nodeData.looperEvt.duration = dur;
                }
                
                finalNoteDuration = dur; // Save for the cursor jump!
                if (typeof drawPianoRoll === 'function') drawPianoRoll(); 
            }
        }

        if (!element.isLooper) {
            activeUserNotes = Math.max(0, activeUserNotes - 1);
            
            // --- THE FIX: SMART MIDI ROLLING DEBOUNCE ---
            if (isStepEntry && activeUserNotes === 0) {
                clearTimeout(stepAdvanceTimeout);
                stepAdvanceTimeout = setTimeout(() => {
                    // Only advance if the user hasn't pressed another key within the 40ms grace period!
                    if (activeUserNotes === 0 && isStepEntryMode) {
                        if (typeof advanceStepCursor === 'function') {
                            // Pass the exact calculated note duration directly to the cursor!
                            advanceStepCursor(finalNoteDuration);
                        }
                    }
                }, 40); 
            }

            if (activeUserNotes === 0) {
                clearTimeout(navFadeTimeout);
                if (uiHideDelay > 0) navFadeTimeout = setTimeout(wakeNav, uiHideDelay); else wakeNav();
            }
        }

        const timeHeld = audioCtx ? (audioCtx.currentTime - nodeData.startTime) : 0;
        const isFastSwipe = timeHeld < 0.08;

        if (isSustainOn() && !forceInstant) sustainedVoices.add(nodeData);
        else beginRelease(nodeData.voices, forceInstant, isFastSwipe);

        updateHighlights();
    }

    // ==========================================
    // 7. MULTITRACK STUDIO ENGINE (Agnostic Tracks)
    // ==========================================

    const studio = {
        activeLooperTrack: 0,
        activeArrangerTrack: 8,
        lastSelectedDomain: 'arranger',
        trackTypes: new Array(16).fill(null),
        trackSynthStates: new Array(16).fill(null),
        trackAudioBuffers: new Array(16).fill(null) // Stores the unzipped Stems
    };

    const looper = {
        isRecording: false, isPlaying: false, isArmed: false,
        startTime: 0, recordingType: null,
        tracks: Array.from({ length: 8 }, () => []),
        regions: Array.from({ length: 8 }, () => []), // NEW: Loop Regions (Arrangement Mode)
        muted: Array(8).fill(false),
        soloed: Array(8).fill(false),
        trackDurations: Array(8).fill(0),
        lastPhases: Array(8).fill(0)
    };

    const arranger = {
        isRecording: false, isPlaying: false, isArmed: false,
        startTime: 0, pauseTime: 0, duration: 0,
        tracks: Array.from({ length: 8 }, () => []),
        muted: Array(8).fill(false),
        soloed: Array(8).fill(false)
    };

    let looperQuantize = false;
    let looperQuantizeRes = 16;

    function captureCurrentSynthState() {
        return {
            osc1: currentOsc1, osc2: currentOsc2, detune: currentDetune, osc2Mult: currentOsc2Mult,
            subOsc: currentSubOsc, noise: currentNoise, resonance: currentResonance,
            brightness: currentBrightness, filterEnv: currentFilterEnv,
            attack: currentAttack, decay: currentDecay, sustain: currentSustain, release: currentRelease,
            oscMix: currentOscMix, glide: currentGlide, filterType: currentFilterType,
            sampleRootKey: parseInt(document.getElementById('sampleRootKey')?.value || 60),
            instrumentPreset: document.getElementById('instrumentPreset')?.value || 'piano',
            lfoDelay: typeof currentLfoDelay !== 'undefined' ? currentLfoDelay : 0,
            lfoFade: typeof currentLfoFade !== 'undefined' ? currentLfoFade : 0,
            lfoKeytrack: typeof currentLfoKeytrack !== 'undefined' ? currentLfoKeytrack : 0,
            lfoPolarity: typeof currentLfoPolarity !== 'undefined' ? currentLfoPolarity : 'bipolar',
            overtones: typeof currentOvertones !== 'undefined' ? currentOvertones : 0,
            glideMode: typeof currentGlideMode !== 'undefined' ? currentGlideMode : 'always',
            vibrato: typeof currentVibrato !== 'undefined' ? currentVibrato : 0,
            sweep: typeof currentSweep !== 'undefined' ? currentSweep : 0,
            tremolo: typeof currentTremolo !== 'undefined' ? currentTremolo : 0,
            osc2Pitch: parseInt(document.getElementById('osc2Pitch')?.value || 0),
            sampleStart: parseFloat(document.getElementById('sampleStart')?.value || 0),
            modWheel: typeof currentModWheel !== 'undefined' ? currentModWheel : 0
        };
    }

    // --- DAW FEATURE: Retroactive Track Instrument Synchronization ---
    function syncActiveTrackInstrument(drumType = null) {
        let activeDomain = studio.lastSelectedDomain;
        let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        let localIdx = activeDomain === 'looper' ? activeIdx : activeIdx - 8;
        let domainObj = activeDomain === 'looper' ? looper : arranger;
        
        // 1. Update Track Type & CSS
        if (studio.trackTypes[activeIdx] === null || drumType) {
            studio.trackTypes[activeIdx] = drumType ? 'drum' : 'voice';
            const btn = document.querySelector(`.track-btn[data-track="${activeIdx}"]`);
            if (btn) btn.classList.add(drumType ? 'type-drum' : 'type-voice');
        }

        // ---> DYNAMIC AUDIO BUS ROUTING <---
        if (typeof audioCtx !== 'undefined' && audioCtx) {
            const panner = activeDomain === 'looper' ? looperPanners[localIdx] : linearPanners[localIdx];
            if (panner) {
                panner.disconnect(); // Unplug the cable
                panner.connect(studio.trackTypes[activeIdx] === 'drum' ? drumGain : synthGain); // Plug into correct bus
            }
        }

        // 2. Update Track Label & State Memory
        const labelEl = document.getElementById(`inst-label-${activeIdx}`);
        const instSelect = document.getElementById('instrumentPreset');
        
        if (drumType) {
            if (labelEl) labelEl.textContent = 'DRUMS';
        } else {
            const newState = captureCurrentSynthState();
            studio.trackSynthStates[activeIdx] = newState; // Update global track memory
            
            if (labelEl && instSelect && instSelect.selectedIndex >= 0) {
                labelEl.textContent = instSelect.options[instSelect.selectedIndex].text;
            }
            
            // 3. Retroactively update all existing notes on this track!
            domainObj.tracks[localIdx].forEach(evt => {
                if (evt.type === 'play') evt.synthState = newState;
            });
        }
    }

    function applySynthStateToUI(s) {
        if (!s) return;
        const presetEl = document.getElementById('instrumentPreset');
        if (presetEl) presetEl.value = s.instrumentPreset;
        const filterEl = document.getElementById('filterType');
        if (filterEl) { filterEl.value = s.filterType; currentFilterType = s.filterType; }

        currentOsc1 = s.osc1; currentOsc2 = s.osc2; currentOsc2Mult = s.osc2Mult;
        
        // Ensure the global tracking variables update even if the UI fails
        if (s.osc2Pitch !== undefined) currentOsc2Pitch = s.osc2Pitch;
        if (s.sampleStart !== undefined) currentSampleStart = s.sampleStart;

        // THE FIX: Add the new parameters to the UI sync map
        const map = {
            detune: s.detune, subOsc: s.subOsc, noise: s.noise, resonance: s.resonance,
            brightness: s.brightness, filterEnv: s.filterEnv, attack: s.attack, decay: s.decay,
            sustain: s.sustain, release: s.release, oscMix: s.oscMix, glide: s.glide,
            lfoDelay: s.lfoDelay, lfoFade: s.lfoFade, lfoKeytrack: s.lfoKeytrack,
            overtones: s.overtones, vibrato: s.vibrato, sweep: s.sweep, tremolo: s.tremolo,
            sampleRootKey: s.sampleRootKey,
            
            // --- NEW VARIABLES ADDED HERE ---
            osc2Pitch: s.osc2Pitch,
            sampleStart: s.sampleStart,
            modWheel: s.modWheel
        };
        
        for (const [id, val] of Object.entries(map)) {
            const el = document.getElementById(id);
            if (el && val !== undefined) { el.value = val; el.dispatchEvent(new Event('input')); }
        }

        if (s.lfoPolarity !== undefined) {
            currentLfoPolarity = s.lfoPolarity;
            const pEl = document.getElementById('lfoPolarity');
            if (pEl) pEl.value = currentLfoPolarity;
        }
        
        if (s.glideMode !== undefined) {
            currentGlideMode = s.glideMode;
            const gEl = document.getElementById('glideMode');
            if (gEl) gEl.value = currentGlideMode;
        }

        if (typeof drawEnvelope === 'function') drawEnvelope();
        
        // Explicitly sync the Macro Dashboard!
        if (typeof syncAllMacros === 'function') syncAllMacros();
    }

    // Boot-up: Populate all 16 memory slots with the default synth
    for (let i = 0; i < 16; i++) studio.trackSynthStates[i] = captureCurrentSynthState();

    function updateStudioUI() {
        // Track Button Flashing (Red = Recording, Yellow = Armed)
        document.querySelectorAll('.track-btn').forEach(b => b.classList.remove('recording-track', 'armed-track'));
        if (looper.isArmed) document.querySelector(`.track-btn[data-track="${studio.activeLooperTrack}"]`)?.classList.add('armed-track');
        else if (looper.isRecording) document.querySelector(`.track-btn[data-track="${studio.activeLooperTrack}"]`)?.classList.add('recording-track');
        
        if (arranger.isArmed) document.querySelector(`.track-btn[data-track="${studio.activeArrangerTrack}"]`)?.classList.add('armed-track');
        else if (arranger.isRecording) document.querySelector(`.track-btn[data-track="${studio.activeArrangerTrack}"]`)?.classList.add('recording-track');

        // --- Sync Master Transport Header ---
        const isAnyPlaying = looper.isPlaying || arranger.isPlaying;
        const isAnyArmed = looper.isArmed || arranger.isArmed;
        const isAnyRecording = looper.isRecording || arranger.isRecording;

        const tpPlayBtn = document.getElementById('transportPlay');
        const tpRecBtn = document.getElementById('transportRec');

        if (tpPlayBtn) {
            tpPlayBtn.classList.toggle('playing', isAnyPlaying);
            tpPlayBtn.innerHTML = isAnyPlaying ? '&#x23F8;&#xFE0E;' : '&#x25B6;&#xFE0E;';
        }
        if (tpRecBtn) {
            tpRecBtn.classList.remove('armed', 'recording');
            // THE FIX: Use standard geometric circle (&#x25CF;) instead of Media Record symbol
            if (isAnyArmed) { tpRecBtn.classList.add('armed'); tpRecBtn.innerHTML = '&#x23F2;&#xFE0E;'; }
            else if (isAnyRecording) { tpRecBtn.classList.add('recording'); tpRecBtn.innerHTML = '&#x25CF;'; }
            else { tpRecBtn.innerHTML = '&#x2B24;'; }
        }
    }

    document.getElementById('btnMetronome')?.addEventListener('click', (e) => {
        initAudio(); // Ensure audio context is awake
        metronomeMode = (metronomeMode + 1) % 3;
        const btn = e.target;
    
        if (metronomeMode === 0) {
            // OFF State
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.title = 'Metronome: Off';
            isMetronomePlaying = false;
        } else if (metronomeMode === 1) {
            // COUNT-IN State (Amber)
            btn.style.background = '#ff9800'; 
            btn.style.borderColor = '#ff9800';
            btn.title = 'Metronome: Count-In';
            isMetronomePlaying = true;
            nextMetronomeTick = audioCtx.currentTime + 0.05;
            metronomeBeatCount = 0; // Start on an accent
        } else {
            // CONTINUOUS State (Green)
            btn.style.background = '#4caf50'; 
            btn.style.borderColor = '#4caf50';
            btn.title = 'Metronome: Continuous';
            isMetronomePlaying = true;
            // Don't interrupt phase if it was already ticking from count-in
            if (nextMetronomeTick < audioCtx.currentTime) {
                nextMetronomeTick = audioCtx.currentTime + 0.05;
                metronomeBeatCount = 0;
            }
        }
    });

    // --- UNIFIED TRACK BUTTONS: Selection & Long-Press to Clear ---
    let holdTimer = null;
    const HOLD_DURATION = 2000; // 2 seconds
    let justCleared = false; // Prevents selection if the user was holding to clear

    document.querySelectorAll('.track-btn').forEach(btn => {
        
        // --- 1. LONG PRESS LOGIC (Clear Track) ---
        const startHold = (e) => {
            justCleared = false;
            btn.classList.add('clearing'); // Triggers the red fill CSS animation
            
            holdTimer = setTimeout(() => {
                justCleared = true; // Mark as cleared so the click event ignores it
                const track = parseInt(btn.getAttribute('data-track'));
                const domain = btn.getAttribute('data-domain');
                
                // --- INTEGRATED CLEAR LOGIC ---
                const localIdx = domain === 'looper' ? track : track - 8;
                const domainObj = domain === 'looper' ? looper : arranger;

                // 1. Wipe the data
                domainObj.tracks[localIdx] = [];
                studio.trackAudioBuffers[track] = null; // Free up RAM
                
                if (domain === 'looper') {
                    looper.trackDurations[localIdx] = 0;
                    looper.lastPhases[localIdx] = 0;
                }

                // 2. Reset the UI & Types
                btn.classList.remove('type-voice', 'type-drum');
                studio.trackTypes[track] = null;
                const el = document.getElementById(`inst-label-${track}`);
                if (el) el.textContent = 'EMPTY';

                if (typeof syncAllTrackRouting === 'function') syncAllTrackRouting();

                // 3. Recalculate Arranger Duration
                if (domain === 'arranger') {
                    let maxDur = 0;
                    arranger.tracks.forEach(t => t.forEach(evt => {
                        if (evt.timeOffset + (evt.duration || 0.5) > maxDur) maxDur = evt.timeOffset + (evt.duration || 0.5);
                    }));
                    arranger.duration = maxDur;

                    // Reset clock if we just cleared the whole song
                    if (maxDur === 0) arranger.pauseTime = 0;

                    // Update global master seeker if it exists
                    const masterSeeker = document.getElementById('master-seeker');
                    if (masterSeeker) masterSeeker.value = 0; 
                }
                console.log(`Successfully cleared ${domain} track ${track}`);
                
                // Visual success flash
                btn.classList.remove('clearing');
                btn.classList.add('cleared-flash');
                setTimeout(() => btn.classList.remove('cleared-flash'), 300);
                
            }, HOLD_DURATION);
        };

        const cancelHold = () => {
            if (holdTimer) clearTimeout(holdTimer);
            btn.classList.remove('clearing'); // Resets the red fill animation
        };

        // Bind Hold Events (Mouse + Touch)
        btn.addEventListener('mousedown', startHold);
        btn.addEventListener('mouseup', cancelHold);
        btn.addEventListener('mouseleave', cancelHold);
        btn.addEventListener('touchstart', startHold, { passive: true });
        btn.addEventListener('touchend', cancelHold);
        btn.addEventListener('touchcancel', cancelHold);


        // --- 2. SHORT CLICK LOGIC (Select Track) ---
        btn.addEventListener('click', e => {
            if (justCleared) return; // Abort if they just finished a 3-second clear hold

            const track = parseInt(btn.dataset.track);
            const domain = btn.dataset.domain;

            studio.lastSelectedDomain = domain;

            // Save the state of the previously active track BEFORE switching
            if (domain === 'looper') {
                studio.trackSynthStates[studio.activeLooperTrack] = captureCurrentSynthState();
                studio.activeLooperTrack = track;
            } else {
                studio.trackSynthStates[studio.activeArrangerTrack] = captureCurrentSynthState();
                studio.activeArrangerTrack = track;
            }

            // GLOBAL EXCLUSIVITY: Remove 'active' class from ALL track buttons across both panels
            document.querySelectorAll('.track-btn').forEach(b => b.classList.remove('active'));

            // Highlight the newly selected track
            btn.classList.add('active');

            // Apply the new track's synth state to the UI dials/sliders
            if (studio.trackTypes[track] !== 'drum' && studio.trackSynthStates[track]) {
                applySynthStateToUI(studio.trackSynthStates[track]);
            }
        });
    });

    // =========================================================
    // --- JUMP TO SYNTH SHORTCUT (Event Delegation) ---
    // =========================================================
    document.addEventListener('click', (e) => {
        // Check if the user clicked on a track label
        if (e.target && e.target.classList.contains('inst-label')) {
            // Extract the track number from the ID (e.g., 'inst-label-12' -> 12)
            const idMatch = e.target.id.match(/inst-label-(\d+)/);
            if (idMatch) {
                const trackIndex = parseInt(idMatch[1], 10);
            
                // 1. Programmatically click the actual track button (L1, A1, etc.)
                // This guarantees your native selection logic, highlighting, and engine sync run perfectly!
                const trackBtn = document.querySelector(`.track-btn[data-track="${trackIndex}"]`);
                if (trackBtn) trackBtn.click();
            
                // 2. Open the Synth Panel (if it isn't already active)
                const synthOverlay = document.getElementById('synth-overlay');
                if (synthOverlay && !synthOverlay.classList.contains('active')) {
                    if (typeof toggleOverlay === 'function') {
                        toggleOverlay('synth');
                    } else {
                        document.getElementById('btnToggleSynth')?.click();
                    }
                }
            }
        }
    });

    // =======================================================
    // UNIFIED MIXER GAIN CONTROLLER (Volume, Mute, Solo, & VCA)
    // =======================================================
    function updateMixerGains() {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;

        const looperVcaSlider = document.getElementById('looperVCA');
        const looperVcaMultiplier = looperVcaSlider ? parseFloat(looperVcaSlider.value) : 1.0;

        const applyGains = (domainObj, gainNodes, trackOffset, vcaMultiplier) => {
            const isSoloActive = domainObj.soloed.some(s => s);
            
            // DYNAMIC LOOP: Count based on the actual array size, not a hardcoded 8!
            for (let i = 0; i < gainNodes.length; i++) {
                if (!gainNodes[i]) continue;
                
                const slider = document.querySelector(`.track-vol[data-track="${i + trackOffset}"]`);
                const baseVol = slider ? parseFloat(slider.value) : 1.0;
                
                let targetGain = baseVol * vcaMultiplier;
                if (domainObj.muted[i] || (isSoloActive && !domainObj.soloed[i])) {
                    targetGain = 0;
                }
                
                gainNodes[i].gain.setTargetAtTime(targetGain, now, 0.015);
            }
        };

        applyGains(looper, looperGainNodes, 0, looperVcaMultiplier);
        applyGains(arranger, linearGainNodes, 8, 1.0);
    }

    // --- EVENT DELEGATION: Automatically supports dynamically added tracks! ---
    const mixerOverlay = document.getElementById('mixer-overlay');
    if (mixerOverlay) {
        
        // 1. Unified Slider Tracking
        mixerOverlay.addEventListener('input', e => {
            if (e.target.classList.contains('echo-send')) {
                const trackIdx = parseInt(e.target.getAttribute('data-track'));
                const nodes = trackIdx < 8 ? looperEchoSends : linearEchoSends;
                const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
                if (nodes[localIdx] && audioCtx) nodes[localIdx].gain.setTargetAtTime(parseFloat(e.target.value), audioCtx.currentTime, 0.015);
            }
            else if (e.target.classList.contains('reverb-send')) {
                const trackIdx = parseInt(e.target.getAttribute('data-track'));
                const nodes = trackIdx < 8 ? looperReverbSends : linearReverbSends;
                const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
                if (nodes[localIdx] && audioCtx) nodes[localIdx].gain.setTargetAtTime(parseFloat(e.target.value), audioCtx.currentTime, 0.015);
            }
            else if (e.target.classList.contains('pan-slider')) {
                const trackIdx = parseInt(e.target.getAttribute('data-track'));
                const nodes = trackIdx < 8 ? looperPanners : linearPanners;
                const localIdx = trackIdx < 8 ? trackIdx : trackIdx - 8;
                if (nodes[localIdx]) nodes[localIdx].pan.value = parseFloat(e.target.value);
            }
            else if (e.target.classList.contains('track-vol')) {
                updateMixerGains();
            }
        });

        // 2. Unified Mute/Solo Tracking
        mixerOverlay.addEventListener('click', e => {
            if (e.target.classList.contains('mute-btn')) {
                const isSolo = e.target.classList.contains('solo-btn');
                if (!isSolo && e.target.classList.contains('edit-btn')) return; 
                
                const track = parseInt(e.target.dataset.track);
                const isLooper = track < 8;
                const domainObj = isLooper ? looper : arranger;
                const localIdx = isLooper ? track : track - 8;

                if (isSolo) {
                    domainObj.soloed[localIdx] = !domainObj.soloed[localIdx];
                    e.target.classList.toggle('soloed', domainObj.soloed[localIdx]);
                } else {
                    domainObj.muted[localIdx] = !domainObj.muted[localIdx];
                    e.target.classList.toggle('muted', domainObj.muted[localIdx]);
                }
                updateMixerGains();
            }
        });
    }

    // --- UNIFIED TRACK BUTTONS: Selection & Long-Press to Clear ---
    function bindTrackButtonEvents(btn) {
        if (btn._isBound) return; // Prevent double-binding on dynamically added buttons
        btn._isBound = true;
        
        let holdTimer = null;
        const HOLD_DURATION = 2000;
        let justCleared = false; 

        const startHold = (e) => {
            justCleared = false;
            btn.classList.add('clearing'); 
            
            holdTimer = setTimeout(() => {
                justCleared = true; 
                const track = parseInt(btn.getAttribute('data-track'));
                const domain = btn.getAttribute('data-domain');
                const localIdx = domain === 'looper' ? track : track - 8;
                const domainObj = domain === 'looper' ? looper : arranger;

                domainObj.tracks[localIdx] = [];
                studio.trackAudioBuffers[track] = null; 
                if (domain === 'looper') { looper.trackDurations[localIdx] = 0; looper.lastPhases[localIdx] = 0; }

                btn.classList.remove('type-voice', 'type-drum');
                studio.trackTypes[track] = null;
                const el = document.getElementById(`inst-label-${track}`);
                if (el) el.textContent = 'EMPTY';

                if (domain === 'arranger') {
                    let maxDur = 0;
                    arranger.tracks.forEach(t => t.forEach(evt => { if (evt.timeOffset + (evt.duration || 0.5) > maxDur) maxDur = evt.timeOffset + (evt.duration || 0.5); }));
                    arranger.duration = maxDur;
                    if (maxDur === 0) arranger.pauseTime = 0;
                }
                
                btn.classList.remove('clearing');
                btn.classList.add('cleared-flash');
                setTimeout(() => btn.classList.remove('cleared-flash'), 300);
            }, HOLD_DURATION);
        };

        const cancelHold = () => { if (holdTimer) clearTimeout(holdTimer); btn.classList.remove('clearing'); };

        btn.addEventListener('mousedown', startHold); btn.addEventListener('mouseup', cancelHold); btn.addEventListener('mouseleave', cancelHold);
        btn.addEventListener('touchstart', startHold, { passive: true }); btn.addEventListener('touchend', cancelHold); btn.addEventListener('touchcancel', cancelHold);

        btn.addEventListener('click', e => {
            if (justCleared) return; 

            const track = parseInt(btn.dataset.track);
            const domain = btn.dataset.domain;
            studio.lastSelectedDomain = domain;

            if (domain === 'looper') { studio.trackSynthStates[studio.activeLooperTrack] = captureCurrentSynthState(); studio.activeLooperTrack = track; } 
            else { studio.trackSynthStates[studio.activeArrangerTrack] = captureCurrentSynthState(); studio.activeArrangerTrack = track; }

            document.querySelectorAll('.track-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (studio.trackTypes[track] !== 'drum' && studio.trackSynthStates[track]) applySynthStateToUI(studio.trackSynthStates[track]);
            
            // --- NEW: Update Piano Roll Label ---
            updatePianoRollTrackLabel();
        });
    }

    // Bind all tracks that exist on startup
    document.querySelectorAll('.track-btn').forEach(bindTrackButtonEvents);

    // =====================================================================
    // MASTER TRANSPORT HEADER LOGIC
    // =====================================================================
    const transportPlay = document.getElementById('transportPlay');
    const transportStop = document.getElementById('transportStop');
    const transportRec = document.getElementById('transportRec');
    const globalTimeDisplay = document.getElementById('global-time-display');
    const globalBpmDisplay = document.getElementById('global-bpm-display');

    function toggleMasterPlayback() {
        initAudio();
        const isPlaying = looper.isPlaying || arranger.isPlaying;

        if (isPlaying) {
            // Save the pause state correctly based on which engine was driving
            if (arranger.isPlaying) arranger.pauseTime = audioCtx.currentTime - arranger.startTime;
            else if (looper.isPlaying) arranger.pauseTime = audioCtx.currentTime - looper.startTime;
            
            looper.isPlaying = false;
            arranger.isPlaying = false;

        } else {
            // Play (Syncs both engines using the global pre-roll constant!)
            const now = audioCtx.currentTime + AUDIO_PREROLL; 
            arranger.isPlaying = true;
            arranger.startTime = now - arranger.pauseTime;
            lastArrangerPhase = arranger.pauseTime - 0.01;
            
            looper.isPlaying = true;
            looper.startTime = arranger.startTime; 
            looper.lastPhases.fill(-0.01); 

            if (midiSyncMode === 'master' && midiOut) {
                midiOut.send([250]);
                nextMidiPulseTime = now;
            }

            // Auto-scroll the piano roll if it's open
            isPrAutoScroll = true;
            document.getElementById('btnPrAutoScroll')?.classList.add('active');
        }
        updateStudioUI();
    }

    // --- GLOBAL TIMELINE SCRUBBING ---
    const globalSeeker = document.getElementById('global-timeline-seeker');
    let isGlobalSeeking = false;

    function shiftGlobalTime(shiftSecs) {
        arranger.pauseTime = Math.max(0, arranger.pauseTime + shiftSecs);
        if (arranger.isPlaying) arranger.startTime -= shiftSecs;
        lastArrangerPhase = arranger.pauseTime - 0.01;

        looper.lastPhases.fill(0);
        if (looper.isPlaying) looper.startTime = audioCtx.currentTime - arranger.pauseTime;

        activeNodes.forEach((nodeData, elementKey) => {
            if (elementKey && elementKey.isLooper) stopFrequencies(elementKey, true);
        });

        if (typeof drawPianoRoll === 'function') drawPianoRoll();
    }

    document.getElementById('btnMasterRw')?.addEventListener('click', () => shiftGlobalTime(-(60 / currentArpBPM) * 4));
    document.getElementById('btnMasterFf')?.addEventListener('click', () => shiftGlobalTime((60 / currentArpBPM) * 4));

    globalSeeker?.addEventListener('mousedown', () => isGlobalSeeking = true);
    globalSeeker?.addEventListener('touchstart', () => isGlobalSeeking = true, { passive: true });

    // Instantly update the text display while dragging the master slider
    globalSeeker?.addEventListener('input', (e) => {
        let maxDuration = Math.max(arranger.duration, ...looper.trackDurations);
        if (maxDuration > 0) {
            const newTime = (parseFloat(e.target.value) / 100) * maxDuration;
            const beatSecs = 60 / currentArpBPM;
            const totalBeats = Math.max(0, newTime / beatSecs);
        
            // BUGFIX: Use beatsPerBar instead of hardcoded 4 for odd time signatures!
            const bars = Math.floor(totalBeats / beatsPerBar) + 1; 
            const beats = Math.floor(totalBeats % beatsPerBar) + 1;

            if (globalTimeDisplay) {
                globalTimeDisplay.style.whiteSpace = 'nowrap';
                const validTime = isNaN(newTime) || newTime < 0 ? 0 : newTime;
                const mins = Math.floor(validTime / 60).toString().padStart(2, '0');
                const secs = Math.floor(validTime % 60).toString().padStart(2, '0');
                const tenths = Math.floor((validTime % 1) * 10);
            
                globalTimeDisplay.innerHTML = `
                <span style="font-weight: bold; color: #fff;">${bars}.${beats}</span> 
                <span style="opacity: 0.5; margin: 0 4px;">|</span> 
                <span style="color: #aaa; font-size: 0.85em;">${mins}:${secs}.${tenths}</span>
            `;
            }

            // Temporarily update engine time so the Piano Roll tracks the drag live!
            if (!arranger.isPlaying && !looper.isPlaying) {
                arranger.pauseTime = newTime;
                if (typeof drawPianoRoll === 'function') drawPianoRoll();
            }
        }
    });

    const finishGlobalSeek = () => {
        if (!isGlobalSeeking) return;
        isGlobalSeeking = false;

        let maxDuration = Math.max(arranger.duration, ...looper.trackDurations);

        if (maxDuration > 0) {
            const newTime = (parseFloat(globalSeeker.value) / 100) * maxDuration;
            if (arranger.isPlaying || looper.isPlaying) {
                arranger.startTime = audioCtx.currentTime - newTime;
                looper.startTime = audioCtx.currentTime - newTime; // Sync looper
            } else {
                arranger.pauseTime = newTime;
            }

            lastArrangerPhase = newTime - 0.01;
            looper.lastPhases.fill(0);

            activeNodes.forEach((nodeData, elementKey) => {
                if (elementKey && elementKey.isLooper) stopFrequencies(elementKey, true);
            });
        }
    };

    globalSeeker?.addEventListener('mouseup', finishGlobalSeek);
    globalSeeker?.addEventListener('touchend', finishGlobalSeek);

    function stopMasterPlayback() {
        looper.isPlaying = false;
        looper.isRecording = false;
        looper.isArmed = false;
        looper.lastPhases.fill(0);

        arranger.isPlaying = false;
        arranger.isRecording = false;
        arranger.isArmed = false;
        arranger.pauseTime = 0;
        lastArrangerPhase = -0.1;

        // --- AUTO-STOP METRONOME ---
        if (isMetronomePlaying) {
            isMetronomePlaying = false;
            metronomeMode = 0;
            const btn = document.getElementById('btnMetronome');
            if (btn) {
                btn.style.background = '';
                btn.style.borderColor = '';
                btn.title = 'Metronome: Off';
            }
        }

        if (midiSyncMode === 'master' && midiOut) midiOut.send([252]);

        // Reset UI Seekers
        const seeker = document.getElementById('arranger-seeker');
        if (seeker) seeker.value = 0;
        const pBar = document.getElementById('looper-progress-fill');
        if (pBar) pBar.style.width = '0%';

        // Kill hanging notes
        activeNodes.forEach((nodeData, elementKey) => { if (elementKey && elementKey.isLooper) stopFrequencies(elementKey, true); });

        updateStudioUI();
    }

    function toggleMasterRecord() {
        let activeDomain = studio.lastSelectedDomain;
        let domainObj = activeDomain === 'looper' ? looper : arranger;

        if (!domainObj.isPlaying && !domainObj.isArmed && !domainObj.isRecording) {
            domainObj.isArmed = true;
        } else if (domainObj.isArmed) {
            domainObj.isArmed = false;
        } else {
            domainObj.isRecording = !domainObj.isRecording;
        }
        updateStudioUI();
    }

    transportPlay?.addEventListener('click', toggleMasterPlayback);
    transportStop?.addEventListener('click', stopMasterPlayback);
    transportRec?.addEventListener('click', toggleMasterRecord);

    // --- Transport Controls ---
    document.getElementById('btnLooperRec')?.addEventListener('click', () => {
        if (!looper.isPlaying && !looper.isArmed) { looper.isArmed = true; }
        else if (looper.isArmed) { looper.isArmed = false; }
        else { looper.isRecording = !looper.isRecording; }
        updateStudioUI();
    });

    document.getElementById('btnLooperPlay')?.addEventListener('click', () => {
        if (looper.isPlaying) {
            looper.isPlaying = false; looper.isRecording = false; looper.isArmed = false;
            looper.lastPhases.fill(0); 
            const pFill = document.getElementById('looper-progress-fill'); if (pFill) pFill.style.width = '0%';
            if (midiSyncMode === 'master' && midiOut) midiOut.send([252]);
        } else {
            looper.isPlaying = true;
            // Use global pre-roll constant
            const now = audioCtx ? audioCtx.currentTime + AUDIO_PREROLL : 0;
            looper.startTime = now;
            looper.lastPhases.fill(-0.01);
            if (midiSyncMode === 'master' && midiOut) {
                midiOut.send([250]);
                nextMidiPulseTime = now;
            }
        }
        updateStudioUI();
    });

    let isArrangerSeeking = false;

    document.getElementById('btnArrangerRec')?.addEventListener('click', () => {
        if (!arranger.isPlaying && !arranger.isArmed && !arranger.isRecording) {
            arranger.isArmed = true;
        } else if (arranger.isArmed) {
            arranger.isArmed = false;
        } else {
            arranger.isRecording = !arranger.isRecording;
        }
        updateStudioUI();
    });

    document.getElementById('btnArrangerPlay')?.addEventListener('click', () => {
        if (arranger.isPlaying) {
            arranger.isPlaying = false; arranger.isRecording = false; arranger.isArmed = false;
            arranger.pauseTime = audioCtx.currentTime - arranger.startTime;
        } else {
            arranger.isPlaying = true;
            // Use global pre-roll constant
            const now = audioCtx ? audioCtx.currentTime + AUDIO_PREROLL : 0;
            arranger.startTime = now - arranger.pauseTime;
            lastArrangerPhase = arranger.pauseTime - 0.01; 
        }
        updateStudioUI();
    });

    const updateArrangerTime = (shiftSecs) => {
        arranger.pauseTime = Math.max(0, arranger.pauseTime + shiftSecs);
        if (arranger.isPlaying) arranger.startTime -= shiftSecs;
        lastArrangerPhase = arranger.pauseTime - 0.01;

        // Instantly kill currently playing notes so they don't hang during rewind
        activeNodes.forEach((nodeData, elementKey) => { if (elementKey && elementKey.isLooper) stopFrequencies(elementKey, true); });
    };
    document.getElementById('btn-arranger-rw')?.addEventListener('click', () => updateArrangerTime(-5));
    document.getElementById('btn-arranger-ff')?.addEventListener('click', () => updateArrangerTime(5));

    // Arranger Scrubber Logic
    const arrSeeker = document.getElementById('arranger-seeker');
    arrSeeker?.addEventListener('mousedown', () => isArrangerSeeking = true);
    arrSeeker?.addEventListener('touchstart', () => isArrangerSeeking = true, { passive: true });
    arrSeeker?.addEventListener('input', (e) => {
        if (arranger.duration > 0) {
            const newTime = (parseFloat(e.target.value) / 100) * arranger.duration;
            const timeDisp = document.getElementById('arranger-time-display');
            if (timeDisp) { const m = Math.floor(newTime / 60); const s = Math.floor(newTime % 60).toString().padStart(2, '0'); timeDisp.textContent = `${m}:${s}`; }
        }
    });
    const finishArrangerSeek = () => {
        if (!isArrangerSeeking) return;
        isArrangerSeeking = false;
        if (arranger.duration > 0) {
            const newTime = (parseFloat(arrSeeker.value) / 100) * arranger.duration;
            if (arranger.isPlaying) arranger.startTime = audioCtx.currentTime - newTime; else arranger.pauseTime = newTime;
            lastArrangerPhase = newTime - 0.01;
            activeNodes.forEach((nodeData, elementKey) => { if (elementKey && elementKey.isLooper) stopFrequencies(elementKey, true); });
        }
    };
    arrSeeker?.addEventListener('mouseup', finishArrangerSeek);
    arrSeeker?.addEventListener('touchend', finishArrangerSeek);

    document.getElementById('btnGlobalClear')?.addEventListener('click', () => {
        const domain = studio.lastSelectedDomain;
        const track = domain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        const domainObj = domain === 'looper' ? looper : arranger;
        const localIdx = domain === 'looper' ? track : track - 8;

        domainObj.tracks[localIdx] = [];
        studio.trackAudioBuffers[track] = null; // Free up RAM
        if (domain === 'looper') {
            looper.trackDurations[localIdx] = 0;
            looper.lastPhases[localIdx] = 0;
        }
        document.querySelector(`.track-btn[data-track="${track}"]`)?.classList.remove('type-voice', 'type-drum');
        studio.trackTypes[track] = null;
        const el = document.getElementById(`inst-label-${track}`);
        if (el) el.textContent = 'EMPTY';

        // Re-calculate the max duration if we clear an arranger track
        if (domain === 'arranger') {
            let maxDur = 0;
            arranger.tracks.forEach(t => t.forEach(evt => {
                if (evt.timeOffset + (evt.duration || 0.5) > maxDur) maxDur = evt.timeOffset + (evt.duration || 0.5);
            }));
            arranger.duration = maxDur;

            // Reset clock if we just cleared the whole song
            if (maxDur === 0) arranger.pauseTime = 0;

            // Force an instant slider update
            const seeker = document.getElementById('arranger-seeker');
            if (seeker) seeker.value = 0;
        }
    });

    // --- INPUT SNAP (Grid Quantization) ---
    document.getElementById('looperQuantizeRes')?.addEventListener('change', e => {
        const val = e.target.value;
    
        if (val === 'off') {
            looperQuantize = false;
            // Optional: Dim the select box slightly when OFF to visually confirm it's inactive
            e.target.style.opacity = '0.6'; 
        } else {
            looperQuantize = true;
            looperQuantizeRes = parseInt(val);
            e.target.style.opacity = '1.0';
        }
    });
    // Run it once on startup to set the initial opacity/state based on your default HTML
    document.getElementById('looperQuantizeRes')?.dispatchEvent(new Event('change'));

    function recordStudioEvent(freqs, type, originalStArray, drumType = null, velocity = 100, exactTime = null) {
        if (!audioCtx) return null;
        let timeToUse = exactTime !== null ? exactTime : audioCtx.currentTime;
        let evtCreated = null;

        const writeEvent = (targetTrack, offsetTime, domainObj, isLooperDomain) => {
            let localIdx = isLooperDomain ? targetTrack : targetTrack - 8;

            // Smart Routing: Prevent Drum Machine from stealing the UI track if user is playing Piano
            if (studio.trackTypes[targetTrack] !== null && studio.trackTypes[targetTrack] !== type) {
                const startIdx = isLooperDomain ? 0 : 8;
                let found = false;
                for (let i = startIdx; i < startIdx + 8; i++) { if (studio.trackTypes[i] === type) { targetTrack = i; found = true; break; } }
                if (!found) { for (let i = startIdx; i < startIdx + 8; i++) { if (studio.trackTypes[i] === null) { targetTrack = i; found = true; break; } } }
                if (!found) return null; // No tracks left

                localIdx = isLooperDomain ? targetTrack : targetTrack - 8;

                // Only update UI focus if a human triggered it (exactTime is null for live play)
                if (exactTime === null) {
                    if (isLooperDomain) studio.activeLooperTrack = targetTrack; else studio.activeArrangerTrack = targetTrack;
                    document.querySelectorAll(`.track-btn[data-domain="${isLooperDomain ? 'looper' : 'arranger'}"]`).forEach(b => b.classList.remove('active'));
                    document.querySelector(`.track-btn[data-track="${targetTrack}"]`)?.classList.add('active');
                }
            }

            // ========================================================
            // THE NEW DYNAMIC ROUTING FIX (NO MORE SYNTH BUS BLEED)
            // ========================================================
            const previousType = studio.trackTypes[targetTrack];
            studio.trackTypes[targetTrack] = type;
            
            const btn = document.querySelector(`.track-btn[data-track="${targetTrack}"]`);
            if (btn) {
                btn.classList.remove('type-drum', 'type-voice');
                btn.classList.add(type === 'drum' ? 'type-drum' : 'type-voice');
            }

            const pNodes = isLooperDomain ? looperPanners : linearPanners;

            // If the track type changed (or was just initialized), unplug the 
            // panner from whatever bus it was attached to, and plug it into the correct one!
            if (previousType !== type && typeof audioCtx !== 'undefined' && pNodes[localIdx]) {
                try {
                    // Hard-disconnect the panner from all master buses to kill the Synth bleed
                    pNodes[localIdx].disconnect(); 
                    
                    // Reconnect to the proper bus
                    const targetBus = type === 'drum' ? drumGain : synthGain;
                    if (targetBus) pNodes[localIdx].connect(targetBus);
                } catch (err) {
                    console.warn("Routing disconnect bypassed:", err);
                }
            }
            // ========================================================

            if (type === 'drum') {
                const isDup = domainObj.tracks[localIdx].some(e => e.drumType === drumType && Math.abs(e.timeOffset - offsetTime) < 0.05);
                if (isDup) return null;
            }

            let synthState = null;
            const labelEl = document.getElementById(`inst-label-${targetTrack}`);
            if (type !== 'drum') {
                synthState = captureCurrentSynthState();
                    
                // Immediately stamp the global track memory so it doesn't stay as the default Piano!
                studio.trackSynthStates[targetTrack] = synthState; 
                    
                const instSelect = document.getElementById('instrumentPreset');
                // Added a safety check to ensure selectedIndex exists!
                if (labelEl && instSelect && instSelect.selectedIndex >= 0) {
                    labelEl.textContent = instSelect.options[instSelect.selectedIndex].text;
                }
            } else if (labelEl) {
                labelEl.textContent = 'DRUMS';
            }

            let createdEvts = [];

            // Explode chords into individual single-note events!
            if (type === 'play' && freqs && freqs.length > 0) {
                freqs.forEach((f, idx) => {
                    const singleSt = originalStArray && originalStArray[idx] !== undefined ? [originalStArray[idx]] : null;
                    
                    // THE FIX: Add 'recordedAt' timestamp to prevent Double Monitoring
                    const evt = { id: Math.random(), freqs: [f], timeOffset: offsetTime, type, stArray: singleSt, drumType, velocity, duration: 0.5, synthState, recordedAt: audioCtx.currentTime };
                    domainObj.tracks[localIdx].push(evt);
                    createdEvts.push(evt);
                });
            } else {
                // Handles Drums (where freqs is null) or single-note melodies
                
                // THE FIX: Add 'recordedAt' timestamp to prevent Double Monitoring
                const evt = { id: Math.random(), freqs, timeOffset: offsetTime, type, stArray: originalStArray, drumType, velocity, duration: 0.5, synthState, recordedAt: audioCtx.currentTime };
                domainObj.tracks[localIdx].push(evt);
                createdEvts.push(evt);
            }

            if (studio.trackTypes[targetTrack] === 'drum') document.querySelector(`.track-btn[data-track="${targetTrack}"]`)?.classList.add('type-drum');
            else document.querySelector(`.track-btn[data-track="${targetTrack}"]`)?.classList.add('type-voice');

            return createdEvts;
        };

        if (looper.isRecording) {
            const lenEl = document.getElementById('looperLength');
            const loopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * (60 / currentArpBPM);
            let offset = (timeToUse - looper.startTime) % loopSec;
            if (offset < 0) offset += loopSec;
            if (typeof looperQuantize !== 'undefined' && looperQuantize) {
                const stepDuration = (60 / currentArpBPM) * (4 / (typeof looperQuantizeRes !== 'undefined' ? looperQuantizeRes : 16));
                offset = Math.round(offset / stepDuration) * stepDuration;
                if (offset >= loopSec) offset = 0;
            }

            evtCreated = writeEvent(studio.activeLooperTrack, offset, looper, true);

            // Stamp the track with this specific loop duration!
            if (evtCreated) {
                looper.trackDurations[studio.activeLooperTrack] = loopSec;
            }
        }

        if (arranger.isRecording) {
            let offset = timeToUse - arranger.startTime;
            if (typeof looperQuantize !== 'undefined' && looperQuantize) {
                const stepDuration = (60 / currentArpBPM) * (4 / (typeof looperQuantizeRes !== 'undefined' ? looperQuantizeRes : 16));
                offset = Math.round(offset / stepDuration) * stepDuration;
            }
            const aEvts = writeEvent(studio.activeArrangerTrack, offset, arranger, false);

            if (aEvts && aEvts.length > 0 && (offset + (aEvts[0].duration || 0.5)) > arranger.duration) {
                arranger.duration = offset + (aEvts[0].duration || 0.5);
            }

            if (!evtCreated) evtCreated = aEvts;
            else if (Array.isArray(evtCreated) && Array.isArray(aEvts)) evtCreated = evtCreated.concat(aEvts);
        }
        return evtCreated;
    }

    // --- Dual Playback Engine ---
    let lastArrangerPhase = 0;
    function processStudioPlayback() {
        if (!audioCtx) return;
    
        // Match the internal engine clock to the 50ms hardware pre-roll!
        // This prevents the timeline from going negative, which stops wrap-around garbage notes!
        const now = audioCtx.currentTime + AUDIO_PREROLL; 
    
        scheduleClickTrack(); // Keep the metronome ticking!

        // Detect if the browser has deep-slept the audio hardware
        if (audioCtx.state === 'suspended' && (looper.isPlaying || arranger.isPlaying)) {
            if (globalTimeDisplay) globalTimeDisplay.textContent = "Zzz...";
            if (document.getElementById('arranger-status-text')) document.getElementById('arranger-status-text').textContent = "BROWSER AUDIO SUSPENDED";
            return; // Halt the sequencer until the user clicks the screen
        }

        // --- UPDATE MASTER LCD TIME & SEEKER ---
        if (globalTimeDisplay) {
            // Track phase based on whichever engine is actively running!
            let phase = 0;
            if (arranger.isPlaying) phase = now - arranger.startTime;
            else if (looper.isPlaying) phase = now - looper.startTime;
            else phase = arranger.pauseTime;

            const beatSecs = 60 / currentArpBPM;
            const totalBeats = Math.max(0, phase / beatSecs);
            const bars = Math.floor(totalBeats / beatsPerBar) + 1;
            const beats = Math.floor(totalBeats % beatsPerBar) + 1;

            // Prevent wrapping and calculate absolute time down to 1/10th of a second
            globalTimeDisplay.style.whiteSpace = 'nowrap';
            const validPhase = isNaN(phase) || phase < 0 ? 0 : phase;
            const mins = Math.floor(validPhase / 60).toString().padStart(2, '0');
            const secs = Math.floor(validPhase % 60).toString().padStart(2, '0');
            const tenths = Math.floor((validPhase % 1) * 10);
            
            globalTimeDisplay.innerHTML = `
                <span style="font-weight: bold; color: #fff;">${bars}.${beats}</span> 
                <span style="opacity: 0.5; margin: 0 4px;">|</span> 
                <span style="color: #aaa; font-size: 0.85em;">${mins}:${secs}.${tenths}</span>
            `;

            // THE FIX: Reset the Chord Recognition rolling memory on the Downbeat!
            if ((arranger.isPlaying || looper.isPlaying) && bars !== currentPlaybackBar) {
                currentPlaybackBar = bars;
                noteMemoryMap.clear(); 
                // Note: We leave rootHistory intact so functional gravity still tracks across bars!
            }

            let maxDuration = Math.max(arranger.duration, ...looper.trackDurations);
            // Move the slider automatically to reflect the ENTIRE project duration
            if (globalSeeker && maxDuration > 0 && !isGlobalSeeking) {
                globalSeeker.value = Math.min(100, (phase / maxDuration) * 100);
            }
        }

        // 1. Process Looper (Independent Multi-Length Polymetric Engine)
        if (looper.isPlaying) {
            const nowOffset = now - looper.startTime;

            // Calculate the default fallback loopSec for the progress bar
            const lenEl = document.getElementById('looperLength');
            const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * (60 / currentArpBPM);

            // The visual progress bar tracks the currently selected UI track!
            const activeTrackLoopSec = looper.trackDurations[studio.activeLooperTrack] || globalLoopSec;
            let activePhase = nowOffset % activeTrackLoopSec;
            if (activePhase < 0) activePhase += activeTrackLoopSec;

            // Only animate the progress bar if the track has data or is actively recording!
            const pBar = document.getElementById('looper-progress-fill');
            if (pBar) {
                const trackHasData = looper.tracks[studio.activeLooperTrack] && looper.tracks[studio.activeLooperTrack].length > 0;
                const isActivelyRecordingToTrack = looper.isRecording && !looper.isArmed; // Only show if punching in

                if (trackHasData || isActivelyRecordingToTrack) {
                    pBar.style.width = `${(activePhase / activeTrackLoopSec) * 100}%`;
                    pBar.style.opacity = '1';
                } else {
                    pBar.style.width = '0%';
                    pBar.style.opacity = '0.3'; // Dim it so the user knows this track is currently empty
                }
            }

            // Loop through all 8 tracks independently
            looper.tracks.forEach((track, idx) => {
                if (track.length === 0) return;

                // --- REGION GATE ---
                const regions = looper.regions[idx];
                if (regions && regions.length > 0) {
                    // Check if the current global time (nowOffset) is inside ANY region painted on this track
                    const isInsideRegion = regions.some(r => nowOffset >= r.start && nowOffset < r.end);
                    if (!isInsideRegion) {
                        looper.lastPhases[idx] = -0.1; // Keep internal loop phase clean while muted
                        return; // Gate is closed! Skip playing notes this frame.
                    }
                }

                const trackLoopSec = looper.trackDurations[idx] || globalLoopSec;
                let phase = nowOffset % trackLoopSec;
                if (phase < 0) phase += trackLoopSec;

                // If this specific track's phase wrapped around to 0, reset its tracker!
                if (phase < looper.lastPhases[idx]) looper.lastPhases[idx] = -0.1;

                track.forEach(evt => {
                    if (evt.timeOffset > looper.lastPhases[idx] && evt.timeOffset <= phase) {
                        
                        // --- THE DOUBLE MONITORING FIX (LOOPER) ---
                        // Ignore events that were recorded a fraction of a second ago!
                        if (evt.recordedAt && Math.abs(audioCtx.currentTime - evt.recordedAt) < 0.15) return;

                        if (evt.type === 'play') {
                            let dummy = { _st: evt.stArray || [], isLooper: true };
                            const isActiveTrack = studio.lastSelectedDomain === 'looper' && studio.activeLooperTrack === idx;
                            const stateToUse = isActiveTrack ? captureCurrentSynthState() : studio.trackSynthStates[idx];
                            playFrequencies(dummy, evt.freqs, evt.stArray, stateToUse, looperGainNodes[idx], evt.velocity);
                            setTimeout(() => stopFrequencies(dummy), (evt.duration || 0.5) * 1000);
                        }
                        else if (evt.type === 'drum') {
                            let exactTime = now + (evt.timeOffset - phase);
                            playDrum(evt.drumType, Math.max(now, exactTime), evt.velocity, looperGainNodes[idx]);
                            highlightDrumBtn(evt.drumType, exactTime);
                        }
                        else if (evt.type === 'stem') {
                            const buffer = studio.trackAudioBuffers[idx]; // <--- Looper uses idx
                            if (buffer) {
                                const source = audioCtx.createBufferSource();
                                source.buffer = buffer;

                                const gain = audioCtx.createGain();
                                gain.gain.value = 1.0;

                                source.connect(gain);

                                if (looperGainNodes[idx]) gain.connect(looperGainNodes[idx]);

                                let exactTime = now + (evt.timeOffset - phase);
                                let bufferOffset = 0;
                                if (exactTime < now) { bufferOffset = now - exactTime; exactTime = now; }

                                // DE-CLICK INJECTION
                                gain.gain.setValueAtTime(0, Math.max(0, exactTime));
                                gain.gain.linearRampToValueAtTime(1.0, Math.max(0, exactTime) + currentDeclick);

                                source.start(exactTime, bufferOffset);

                                const dummyElement = { _st: [], isLooper: true };
                                const dummyFilter = audioCtx.createBiquadFilter();
                                activeNodes.set(dummyElement, {
                                    type: 'stem',
                                    voices: [{ sampleSource: source, gainNode: gain, filter: dummyFilter, isChord: false }]
                                });

                                setTimeout(() => {
                                    if (activeNodes.has(dummyElement)) stopFrequencies(dummyElement, true);
                                }, (buffer.duration - bufferOffset) * 1000);
                            }
                        }
                    }
                });

                // Advance this specific track's playhead
                looper.lastPhases[idx] = phase;
            });
        }

        // 2. Process Arranger
        if (arranger.isPlaying || arranger.isRecording) {
            let phase = now - arranger.startTime;

            // --- DAW AUTO-STOP AT END OF SONG ---
            if (!arranger.isRecording && arranger.duration > 0 && phase >= arranger.duration) {
                // 1. Force kill BOTH engines
                arranger.isPlaying = false;
                looper.isPlaying = false;
                
                // 2. Lock the playhead and phase to the absolute end1
                arranger.pauseTime = arranger.duration;
                phase = arranger.duration;
                
                // 3. Reset the Looper's last phase trackers so it doesn't "ghost play" notes
                looper.lastPhases.fill(0);
                
                // 4. Update the Master LCD to show the final timestamp (e.g. 33.1)
                const beatSecs = 60 / currentArpBPM;
                const totalBeats = phase / beatSecs;
                const bars = Math.floor(totalBeats / beatsPerBar) + 1;
                const beats = Math.floor(totalBeats % beatsPerBar) + 1;
                if (globalTimeDisplay) globalTimeDisplay.textContent = `${bars}.${beats}`;
                
                updateStudioUI();
                return; // Exit immediately to prevent the looper logic below from running!
            }

            // Update Seeker UI (Only if the user isn't currently dragging it!)
            const seeker = document.getElementById('arranger-seeker');
            const timeDisp = document.getElementById('arranger-time-display');
            if (seeker && arranger.duration > 0 && typeof isArrangerSeeking !== 'undefined' && !isArrangerSeeking) {
                seeker.value = Math.min(100, (phase / arranger.duration) * 100);
            }
            if (timeDisp && (typeof isArrangerSeeking === 'undefined' || !isArrangerSeeking)) {
                const m = Math.floor(phase / 60); const s = Math.floor(phase % 60).toString().padStart(2, '0');
                timeDisp.textContent = `${m}:${s}`;
            }

            if (arranger.isPlaying && phase > lastArrangerPhase) {
                arranger.tracks.forEach((track, localIdx) => {
                    track.forEach(evt => {
                        if (evt.timeOffset > lastArrangerPhase && evt.timeOffset <= phase) {
                            
                            // --- THE DOUBLE MONITORING FIX (ARRANGER) ---
                            // Ignore events that were recorded a fraction of a second ago!
                            if (evt.recordedAt && Math.abs(audioCtx.currentTime - evt.recordedAt) < 0.15) return;

                            if (evt.type === 'play') {
                                let dummy = { _st: evt.stArray || [], isLooper: true };
                                const isActiveTrack = studio.lastSelectedDomain === 'arranger' && studio.activeArrangerTrack === (localIdx + 8);
                                const stateToUse = isActiveTrack ? captureCurrentSynthState() : studio.trackSynthStates[localIdx + 8];
                                playFrequencies(dummy, evt.freqs, evt.stArray, stateToUse, linearGainNodes[localIdx], evt.velocity);
                                setTimeout(() => stopFrequencies(dummy), (evt.duration || 0.5) * 1000);
                            }
                            else if (evt.type === 'drum') {
                                let exactTime = now + (evt.timeOffset - phase);
                                playDrum(evt.drumType, Math.max(now, exactTime), evt.velocity, linearGainNodes[localIdx]);
                                highlightDrumBtn(evt.drumType, exactTime);
                            }
                            else if (evt.type === 'stem') {
                                const buffer = studio.trackAudioBuffers[localIdx + 8]; // <--- Arranger offsets by 8
                                if (buffer) {
                                    const source = audioCtx.createBufferSource();
                                    source.buffer = buffer;

                                    const gain = audioCtx.createGain();
                                    gain.gain.value = 1.0;

                                    source.connect(gain);
                                    if (linearGainNodes[localIdx]) gain.connect(linearGainNodes[localIdx]);

                                    let exactTime = now + (evt.timeOffset - phase);
                                    let bufferOffset = 0;
                                    if (exactTime < now) { bufferOffset = now - exactTime; exactTime = now; }

                                    // DE-CLICK INJECTION
                                    gain.gain.setValueAtTime(0, Math.max(0, exactTime));
                                    gain.gain.linearRampToValueAtTime(1.0, Math.max(0, exactTime) + currentDeclick);

                                    source.start(exactTime, bufferOffset);

                                    const dummyElement = { _st: [], isLooper: true };
                                    const dummyFilter = audioCtx.createBiquadFilter();
                                    activeNodes.set(dummyElement, {
                                        type: 'stem',
                                        voices: [{ sampleSource: source, gainNode: gain, filter: dummyFilter, isChord: false }]
                                    });

                                    setTimeout(() => {
                                        if (activeNodes.has(dummyElement)) stopFrequencies(dummyElement, true);
                                    }, (buffer.duration - bufferOffset) * 1000);
                                }
                            }
                        }
                    });
                });
            }
            lastArrangerPhase = phase;
        }
    }

    // =====================================================================
    // --- NEW MASTER OUTPUT BOUNCING PANEL (WITH DEBUG LOGGING) ---
    // =====================================================================
    let isBouncing = false;
    let bounceTimeoutId = null;
    let pendingBounceBlob = null;
    let pendingBounceExt = "";
    let pendingBounceName = "";
    
    // NEW: Audio Routing Safeguards
    let bounceDummySink = null;
    let wasMutedForBounce = false;

    let mediaRecorder;
    let recordedChunks = [];
    let isCustomWavRecording = false;
    let wavRecordingBuffers = [[], []];
    let recorderWorkletNode = null;
    let workletPromise = null;

    // AUDIO WORKLET
    const recorderWorkletCode = `
        class RecorderProcessor extends AudioWorkletProcessor {
            process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (input && input.length >= 2) {
                    this.port.postMessage({
                        left: new Float32Array(input[0]),
                        right: new Float32Array(input[1])
                    });
                }
                if (input && outputs[0]) {
                    for (let channel = 0; channel < input.length; ++channel) {
                        if (outputs[0][channel]) outputs[0][channel].set(input[channel]);
                    }
                }
                return true; 
            }
        }
        registerProcessor('recorder-processor', RecorderProcessor);
    `;

    // 1. Open the Panel
    document.getElementById('btn-master-save')?.addEventListener('click', () => {
        toggleOverlay('bounce');
        const progressText = document.getElementById('bounce-progress-text');
        if (progressText) progressText.style.display = 'none';
        
        if (!pendingBounceBlob && !isBouncing) {
            const btn = document.getElementById('btn-start-bounce');
            if (btn) {
                btn.textContent = "🚀 BOUNCE";
                btn.style.backgroundColor = "#4CAF50"; 
            }
        }
    });

    // 2. Real-time Mute Toggle
    document.getElementById('bounce-mute-speakers')?.addEventListener('change', (e) => {
        if (!isBouncing) return;
        console.log(`[BOUNCE DEBUG] Mute speakers toggled: ${e.target.checked}`);
        if (e.target.checked) {
            try { safetyClipper.disconnect(audioCtx.destination); } catch (err) { }
            if (recorderWorkletNode && bounceDummySink) {
                try { recorderWorkletNode.disconnect(audioCtx.destination); } catch (err) { }
                recorderWorkletNode.connect(bounceDummySink);
            }
        } else {
            try { safetyClipper.connect(audioCtx.destination); } catch (err) { }
            if (recorderWorkletNode) {
                try { recorderWorkletNode.disconnect(bounceDummySink); } catch (err) { }
                recorderWorkletNode.connect(audioCtx.destination);
            }
        }
    });

    // 3. Cancel Flow
    const closeBouncePanel = () => {
        if (isBouncing) {
            console.log("[BOUNCE DEBUG] User canceled bounce process.");
            if (bounceTimeoutId) clearTimeout(bounceTimeoutId);
            isBouncing = false;
            
            looper.isPlaying = arranger.isPlaying = false;
            updateStudioUI();
            
            // --- RESTORE SPEAKER CONNECTIONS ---
            if (wasMutedForBounce) {
                try { safetyClipper.connect(audioCtx.destination); } catch (e) { }
                if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                    try { importedAudioMasterGainNode.connect(audioCtx.destination); } catch (e) { }
                }
                if (bounceDummySink) {
                    bounceDummySink.disconnect();
                    bounceDummySink = null;
                }
                wasMutedForBounce = false;
            }
            
            if (isCustomWavRecording && recorderWorkletNode) {
                recorderWorkletNode.disconnect();
                safetyClipper.disconnect(recorderWorkletNode);
                if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                    try { importedAudioMasterGainNode.disconnect(recorderWorkletNode); } catch (e) { }
                }
                recorderWorkletNode = null;
            } else if (mediaRecorder && mediaRecorder.state !== "inactive") {
                mediaRecorder.stop();
            }
            
            const btn = document.getElementById('btn-start-bounce');
            if (btn) {
                btn.disabled = false;
                btn.textContent = "🚀 BOUNCE";
                btn.style.backgroundColor = "#4CAF50"; 
            }
            showToast("Bounce Canceled.");
        }
        if (isBounceActive) toggleOverlay('bounce');
    };

    document.getElementById('btn-cancel-bounce')?.addEventListener('click', closeBouncePanel);

    // 4. Execution Logic (Start Bounce / Finalize Save)
    document.getElementById('btn-start-bounce')?.addEventListener('click', async () => {
        const btnStart = document.getElementById('btn-start-bounce');

        // ==== PHASE 2: FINAL SAVE ====
        if (pendingBounceBlob) {
            console.log("[BOUNCE DEBUG] Phase 2 initiated: Attempting to save blob...", pendingBounceBlob);
            btnStart.textContent = "💾 SAVING...";
            await finalizeSave(pendingBounceBlob, pendingBounceExt, pendingBounceName, "🚀 BOUNCE");
            pendingBounceBlob = null;
            btnStart.style.backgroundColor = "#4CAF50"; 
            if (isBounceActive) toggleOverlay('bounce');
            return;
        }

        // ==== PHASE 1: START RECORDING ====
        if (isBouncing) return;

        const hasLooperData = looper.tracks.some(t => t.length > 0);
        const hasArrangerData = arranger.tracks.some(t => t.length > 0);
        if (!hasLooperData && !hasArrangerData) {
            showToast("No data to bounce!");
            return;
        }

        isBouncing = true;
        const format = document.getElementById('bounce-format')?.value || 'audio/wav';
        const bitrate = parseInt(document.getElementById('bounce-bitrate')?.value || 192000);
        const rawName = document.getElementById('bounce-filename')?.value.replace(/[^a-zA-Z0-9_\- ]/g, '') || 'TonnetzPro_Master';
        
        pendingBounceExt = format.includes("wav") ? ".wav" :  
            format.includes("ogg") ? ".ogg" :  
                format.includes("mp4") ? ".mp4" : ".webm";
        pendingBounceName = `${rawName}_${Date.now()}${pendingBounceExt}`;

        console.log(`[BOUNCE DEBUG] Starting Phase 1. Format: ${format}, Target file: ${pendingBounceName}`);

        btnStart.disabled = true;
        btnStart.style.backgroundColor = "#666"; 
        btnStart.textContent = "⏳ BOUNCING...";
        const progressText = document.getElementById('bounce-progress-text');
        if (progressText) progressText.style.display = 'block';

        initAudio();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        const lenEl = document.getElementById('looperLength');
        const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * (60 / currentArpBPM);
        const maxLoopSec = Math.max(...looper.trackDurations.map(d => d || 0));
        let exportSec = Math.max(arranger.duration, maxLoopSec, globalLoopSec) + 1.5;

        console.log(`[BOUNCE DEBUG] Calculated bounce duration: ${exportSec} seconds.`);

        recordedChunks = [];
        
        // --- THE AUDIO ROUTING FIX ---
        wasMutedForBounce = document.getElementById('bounce-mute-speakers')?.checked;
        if (wasMutedForBounce) {
            console.log("[BOUNCE DEBUG] Muting speakers via dummy sink routing.");
            try { safetyClipper.disconnect(audioCtx.destination); } catch (e) { }
            if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                try { importedAudioMasterGainNode.disconnect(audioCtx.destination); } catch (e) { }
            }
            
            bounceDummySink = audioCtx.createGain();
            bounceDummySink.gain.value = 0; 
            bounceDummySink.connect(audioCtx.destination);
        }

        if (format === 'audio/wav') {
            isCustomWavRecording = true;
            wavRecordingBuffers = [[], []];

            if (!workletPromise) {
                const blob = new Blob([recorderWorkletCode], { type: 'application/javascript' });
                workletPromise = audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
            }
            await workletPromise;
            console.log("[BOUNCE DEBUG] AudioWorklet injected correctly.");

            recorderWorkletNode = new AudioWorkletNode(audioCtx, 'recorder-processor');
            safetyClipper.connect(recorderWorkletNode);
            if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                try { importedAudioMasterGainNode.connect(recorderWorkletNode); } catch (e) { }
            }
            
            recorderWorkletNode.connect(wasMutedForBounce ? bounceDummySink : audioCtx.destination);
            
            recorderWorkletNode.port.onmessage = (e) => {
                if (isCustomWavRecording) {
                    wavRecordingBuffers[0].push(e.data.left);
                    wavRecordingBuffers[1].push(e.data.right);
                }
            };
        } else {
            isCustomWavRecording = false;
            try {
                mediaRecorder = new MediaRecorder(window.mediaStreamDest.stream, { mimeType: format, audioBitsPerSecond: bitrate });
                console.log("[BOUNCE DEBUG] MediaRecorder created successfully.");
            } catch (err) {
                console.warn(`[BOUNCE DEBUG] Requested codec ${format} unsupported, falling back to browser default.`);
                mediaRecorder = new MediaRecorder(window.mediaStreamDest.stream);
            }
            if (wasMutedForBounce) safetyClipper.connect(bounceDummySink);
            
            mediaRecorder.ondataavailable = (ev) => { if (ev.data.size > 0) recordedChunks.push(ev.data); };
            mediaRecorder.start();
        }

        looper.isPlaying = arranger.isPlaying = true;
        looper.startTime = arranger.startTime = audioCtx.currentTime;
        if (hasLooperData) looper.lastPhases.fill(0);
        if (hasArrangerData) arranger.pauseTime = 0;
        updateStudioUI();

        console.log("[BOUNCE DEBUG] Playback engine started, waiting for timeout...");

        bounceTimeoutId = setTimeout(() => {
            console.log("[BOUNCE DEBUG] Timeout reached! Compiling audio...");
            looper.isPlaying = arranger.isPlaying = false;
            updateStudioUI();
            
            // --- RESTORE SPEAKER CONNECTIONS ---
            if (wasMutedForBounce) {
                try { safetyClipper.connect(audioCtx.destination); } catch (e) { }
                if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                    try { importedAudioMasterGainNode.connect(audioCtx.destination); } catch (e) { }
                }
                if (bounceDummySink) {
                    bounceDummySink.disconnect();
                    bounceDummySink = null;
                }
                wasMutedForBounce = false;
                console.log("[BOUNCE DEBUG] Speaker connections restored.");
            }
            
            if (progressText) progressText.style.display = 'none';

            if (isCustomWavRecording && recorderWorkletNode) {
                recorderWorkletNode.disconnect();
                safetyClipper.disconnect(recorderWorkletNode);
                if (typeof importedAudioMasterGainNode !== 'undefined' && importedAudioMasterGainNode) {
                    try { importedAudioMasterGainNode.disconnect(recorderWorkletNode); } catch (e) { }
                }
                isCustomWavRecording = false;
                recorderWorkletNode = null;

                try {
                    console.log(`[BOUNCE DEBUG] Creating WAV blob. Left buffer chunks: ${wavRecordingBuffers[0].length}`);
                    pendingBounceBlob = exportWAV(wavRecordingBuffers, audioCtx.sampleRate);
                    console.log(`[BOUNCE DEBUG] WAV blob created successfully: ${pendingBounceBlob.size} bytes`);
                    stageBounceSave();
                } catch (e) {
                    console.error("[BOUNCE FATAL ERROR] exportWAV function crashed!", e);
                    showToast("Error creating WAV. See console.");
                    stageBounceSave(); // Will fail cleanly due to null blob
                }
            } else if (mediaRecorder && mediaRecorder.state !== "inactive") {
                mediaRecorder.onstop = () => {
                    try {
                        pendingBounceBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || format });
                        console.log(`[BOUNCE DEBUG] Compressed blob created successfully: ${pendingBounceBlob.size} bytes`);
                        stageBounceSave();
                    } catch (e) {
                        console.error("[BOUNCE FATAL ERROR] Blob generation crashed!", e);
                    }
                };
                mediaRecorder.stop();
            }
        }, exportSec * 1000);
    });

    function stageBounceSave() {
        console.log("[BOUNCE DEBUG] Staging bounce for Phase 2...");
        isBouncing = false;
        const btnStart = document.getElementById('btn-start-bounce');
        if (!btnStart) return;

        if (!pendingBounceBlob || pendingBounceBlob.size === 0) {
            console.error("[BOUNCE DEBUG] Staging failed: Blob is null or 0 bytes.");
            showToast("Bounce failed (Empty audio data).");
            btnStart.disabled = false;
            btnStart.textContent = "🚀 BOUNCE";
            btnStart.style.backgroundColor = "#4CAF50";
            return;
        }
        
        btnStart.textContent = "✅ SAVE MIX";
        btnStart.style.backgroundColor = "#2196F3"; 
        btnStart.disabled = false;
        showToast("Bounce complete! Click 'Save Mix' to download.");
    }

    // --- DYNAMICALLY DISABLE UNSUPPORTED BOUNCE FORMATS ---
    window.addEventListener('DOMContentLoaded', () => {
        const formatDropdown = document.getElementById('bounce-format');
        if (formatDropdown && typeof MediaRecorder !== 'undefined') {
            Array.from(formatDropdown.options).forEach(option => {
                if (option.value === 'audio/wav') return; 
            
                if (!MediaRecorder.isTypeSupported(option.value)) {
                    option.disabled = true;
                    option.textContent = option.textContent.replace(')', ' - Unsupported by browser)');
                }
            });
        }
    });

    async function finalizeSave(blob, ext, defaultName, originalText) {
        console.log(`[BOUNCE DEBUG] finalizeSave called. Ext: ${ext}, Size: ${blob.size}`);
        const btnStart = document.getElementById('btn-start-bounce');
        if (btnStart) {
            btnStart.innerHTML = originalText;
            btnStart.style.backgroundColor = ""; 
        }

        if (!blob) {
            showToast("Bounce failed.");
            return;
        }

        // A. Try Tauri Native
        if (window.__TAURI__) {
            console.log("[BOUNCE DEBUG] Attempting Tauri save...");
            try {
                const path = await window.__TAURI__.dialog.save({ defaultPath: defaultName });
                if (path) {
                    const uint8 = new Uint8Array(await blob.arrayBuffer());
                    await window.__TAURI__.fs.writeBinaryFile(path, uint8);
                    showToast("Saved natively!");
                    return;
                }
            } catch (err) { console.error("[BOUNCE DEBUG] Tauri save failed", err); }
        }

        let safeMime = blob.type;
        if (!safeMime) {
            if (ext === '.wav') safeMime = 'audio/wav';
            else if (ext === '.webm') safeMime = 'audio/webm';
            else if (ext === '.ogg') safeMime = 'audio/ogg';
            else if (ext === '.mp4') safeMime = 'audio/mp4';
            else safeMime = 'application/octet-stream';
        }

        // B. Try Modern File System API (Chrome/Edge/Desktop)
        if ('showSaveFilePicker' in window) {
            console.log("[BOUNCE DEBUG] Attempting modern showSaveFilePicker API...");
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: defaultName,
                    types: [{ description: 'Audio File', accept: { [safeMime]: [ext] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                showToast("Saved successfully!");
                return;
            } catch (err) { 
                if (err.name === 'AbortError') {
                    console.log("[BOUNCE DEBUG] User clicked Cancel in native OS dialog.");
                    return; 
                }
                console.warn("[BOUNCE DEBUG] Modern File Picker failed, falling back to classic...", err);
            }
        } else {
            console.log("[BOUNCE DEBUG] showSaveFilePicker not supported in this browser (Likely Firefox). Falling back...");
        }

        // C. Fallback (Firefox/Safari/Mobile/HTTP / Fallback from API Crash)
        console.log("[BOUNCE DEBUG] Triggering classic HTML download fallback...");
        
        // THE FIX: We removed the blocked prompt() and just use the name we already passed in!
        const finalFileName = defaultName.endsWith(ext) ? defaultName : defaultName + ext;

        console.log(`[BOUNCE DEBUG] Creating virtual download link for: ${finalFileName}`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = finalFileName;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            console.log("[BOUNCE DEBUG] Cleaning up virtual download link.");
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        }, 1000);
    }

    // --- DAWPROJECT XML GENERATOR ---
    function generateProjectXML(activeTracks, bpm) {
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<project xmlns="http://bitwig.com/dawproject/1.0" version="1.0">\n`;
        xml += `  <application name="Tonnetz Pro" version="1.0"/>\n`;
        xml += `  <transport tempo="${bpm}"/>\n`;
        xml += `  <structure>\n`;
        xml += `    <track>\n`; // Master Track

        activeTracks.forEach((t, i) => {
            const isLooper = i < 8;
            const localIdx = isLooper ? i : i - 8;
            const prefix = isLooper ? `L${localIdx + 1}` : `A${localIdx + 1}`;
            const instName = document.getElementById(`inst-label-${i}`)?.textContent || 'Track';
            const cleanName = instName.replace(/[^a-zA-Z0-9]/g, '_');
            const typeLabel = studio.trackTypes[i] === 'drum' ? 'Drums' : 'Synth';
            const fileName = `Track_${(i + 1).toString().padStart(2, '0')}_${prefix}_${typeLabel}_${cleanName}.wav`;

            xml += `      <track name="${prefix} - ${instName}">\n`;
            xml += `        <audio>\n`;
            xml += `          <clip>\n`;
            xml += `            <audio-file path="Audio/${fileName}"/>\n`;
            xml += `          </clip>\n`;
            xml += `        </audio>\n`;
            xml += `      </track>\n`;
        });

        xml += `    </track>\n`;
        xml += `  </structure>\n`;
        xml += `</project>`;
        return xml;
    }

    // --- NON-DESTRUCTIVE PROJECT EXPORTER (.dawproject) ---

    // 1. Show/Hide Panel via the top nav button
    document.getElementById('btn-export-stems')?.addEventListener('click', () => {
        toggleOverlay('export');
        const progressText = document.getElementById('export-progress-text');
        if (progressText) progressText.style.display = 'none';
    });

    // 2. Cancel Button / Abort Export
    document.getElementById('btn-cancel-export')?.addEventListener('click', () => {
        // Abort background export tasks if they are running
        if (isExporting) {
            if (exportAbortController) exportAbortController.abort(); 
            if (exportTimeoutId) clearTimeout(exportTimeoutId);
            isExporting = false;
            
            // Instantly stop audio if we were recording stems
            looper.isPlaying = arranger.isPlaying = false;
            updateStudioUI();
            
            // Restore Master Volume
            const masterVolSlider = document.getElementById('masterVol') || document.getElementById('master-vol');
            if (masterGain) masterGain.gain.setTargetAtTime(parseFloat(masterVolSlider?.value || 1.0), audioCtx.currentTime, 0.05);
            
            showToast("Export Canceled.");
        }
        
        // Hide the panel using the official router
        if (isExportActive) toggleOverlay('export');
    });

    // 3. Execution Logic
    document.getElementById('btn-start-export')?.addEventListener('click', async () => {
        if (isExporting) return;
        if (typeof JSZip === 'undefined') {
            showToast("JSZip library is loading...");
            return;
        }

        isExporting = true;
        exportAbortController = new AbortController();
        const signal = exportAbortController.signal;

        const includeStems = document.getElementById('export-audio-stems')?.checked;
        const rawFilename = document.getElementById('export-filename')?.value.replace(/[^a-zA-Z0-9_\- ]/g, '') || 'TonnetzPro_Project';
        const filename = `${rawFilename}_${currentArpBPM}BPM.dawproject`;
        const progressText = document.getElementById('export-progress-text');

        // 1. Prepare State
        if (studio.lastSelectedDomain === 'looper') {
            studio.trackSynthStates[studio.activeLooperTrack] = captureCurrentSynthState();
        } else {
            studio.trackSynthStates[studio.activeArrangerTrack] = captureCurrentSynthState();
        }

        const hasLooperData = looper.tracks.some(t => t.length > 0);
        const hasArrangerData = arranger.tracks.some(t => t.length > 0);
        if (!hasLooperData && !hasArrangerData) {
            showToast("No data to export!");
            isExporting = false;
            return;
        }

        initAudio();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        // 2. Setup Zip Structure
        const sessionZip = new JSZip(); 
        const audioFolder = sessionZip.folder("Audio");
        const midiFolder = sessionZip.folder("MIDI");
        const rawAssetsFolder = sessionZip.folder("Raw_Assets");
        sessionZip.folder("Plugins");

        // 3. Timing Calculation
        const lenEl = document.getElementById('looperLength');
        const globalLoopSec = (lenEl ? parseInt(lenEl.value) : 4) * 4 * (60 / currentArpBPM);
        const maxLoopSec = Math.max(...looper.trackDurations.map(d => d || 0));
        let exportSec = Math.max(arranger.duration, maxLoopSec, globalLoopSec) + 1.5;

        if (progressText) {
            progressText.style.display = 'block';
            progressText.textContent = "Packaging Project Data...";
        }

        // 4. Raw Assets (The "Non-Destructive" part)
        const savedAssets = new Set();
        const saveAudioBufferToZip = (name, buffer) => {
            if (name && buffer && !savedAssets.has(name)) {
                savedAssets.add(name);
                const chanData = [
                    buffer.getChannelData(0), 
                    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)
                ];
                rawAssetsFolder.file(name, exportWAV(chanData, buffer.sampleRate));
            }
        };

        [looper, arranger].forEach(domain => domain.tracks.forEach(tr => tr.forEach(ev => {
            if (ev.type === 'stem') saveAudioBufferToZip(ev.name, ev.buffer);
        })));

        if (typeof sampleBank !== 'undefined') {
            for (const [key, buffer] of sampleBank.entries()) {
                saveAudioBufferToZip(key.split(':').pop(), buffer);
            }
        }

        // 5. Generate Master FX payload
        const masterState = {
            masterVolume: document.getElementById('masterVol')?.value || 1.0,
            eqLow: document.getElementById('eqLow')?.value || 0,
            eqMid: document.getElementById('eqMid')?.value || 0,
            eqHigh: document.getElementById('eqHigh')?.value || 0,
            declickDelay: document.getElementById('declick')?.value || 10,
            busComp: document.getElementById('busComp')?.value || 0,
            limiter: document.getElementById('limiterMode')?.value || 'none'
        };

        // THE FIX: Capture the 16-track mixer faders
        const mixerState = {
            volumes: Array.from(document.querySelectorAll('.track-vol')).map(el => parseFloat(el.value) || 1.0),
            pans: Array.from(document.querySelectorAll('.pan-slider')).map(el => parseFloat(el.value) || 0.0),
            echoSends: Array.from(document.querySelectorAll('.echo-send')).map(el => parseFloat(el.value) || 0.0),
            reverbSends: Array.from(document.querySelectorAll('.reverb-send')).map(el => parseFloat(el.value) || 0.0)
        };

        const sessionData = {
            bpm: currentArpBPM,
            currentArrangerTrackCount,
            studioState: studio,
            looperState: looper,
            arrangerState: arranger,
            exportDuration: exportSec,
            masterState: masterState,
            mixerState: mixerState // Added to payload!
        };

        const totalTracks = 8 + currentArrangerTrackCount;
        let generatedTrackIds = [];
        
        for (let i = 0; i < totalTracks; i++) {
            const isLooper = i < 8;
            const localIdx = isLooper ? i : i - 8;
            const trackType = studio.trackTypes[i];
            if (trackType === null) continue;

            const domainObj = isLooper ? looper : arranger;
            const trackEvents = domainObj.tracks[localIdx];
            
            if (trackEvents && trackEvents.length > 0) {
                generatedTrackIds.push(i);
                const prefix = isLooper ? `L${localIdx + 1}` : `A${localIdx + 1}`;
                const instName = (document.getElementById(`inst-label-${i}`)?.textContent || 'Track').replace(/[^a-zA-Z0-9]/g, '_');
                const typeLabel = studio.trackTypes[i] === 'drum' ? 'Drums' : 'Synth';
                const fileName = `Track_${(i + 1).toString().padStart(2, '0')}_${prefix}_${typeLabel}_${instName}`;

                const isDrum = studio.trackTypes[i] === 'drum';
                const midiBinary = createMIDIFile(trackEvents, currentArpBPM, isDrum);
                midiFolder.file(`${fileName}.mid`, midiBinary);
            }
        }

        sessionZip.file("project.xml", generateProjectXML(generatedTrackIds, currentArpBPM));
        sessionZip.file("tonnetz_session.json", JSON.stringify(sessionData, null, 2));

        // 6. Branch: Instant Download or Real-time Rendering
        if (!includeStems) {
            // INSTANT EXPORT
            if (progressText) progressText.textContent = "Zipping file...";
            const blob = await sessionZip.generateAsync({ type: "blob" });
            if (signal.aborted) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
            
            document.getElementById('export-panel')?.classList.add('hidden');
            showToast("Instant Export Complete!");
            isExporting = false;
            if (isExportActive) toggleOverlay('export');
            return;
        }

        // 7. Setup Real-time Rendering
        if (progressText) progressText.textContent = "Recording Real-time Audio Stems...";
        const stemPromises = [];
        const isLooperSolo = looper.soloed.some(s => s);
        const isArrangerSolo = arranger.soloed.some(s => s);
    
        let tracksToProcess = 0;
        let tracksFinished = 0;

        // Mute Master for user comfort during silent render
        const prevVol = masterGain.gain.value;
        masterGain.gain.value = 0;

        for (let i = 0; i < totalTracks; i++) {
            const isLooper = i < 8;
            const localIdx = isLooper ? i : i - 8;
            const trackType = studio.trackTypes[i];
            if (trackType === null) continue;

            const isSoloed = isLooper ? looper.soloed[localIdx] : arranger.soloed[localIdx];
            const isMuted = isLooper ? looper.muted[localIdx] : arranger.muted[localIdx];
            const soloActive = isLooper ? isLooperSolo : isArrangerSolo;
            if (isMuted || (soloActive && !isSoloed)) continue;

            const pannerNode = isLooper ? looperPanners[localIdx] : linearPanners[localIdx];
            if (pannerNode) {
                tracksToProcess++;

                const trackRecorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor');
                const trackBuffers = [[], []];

                pannerNode.connect(trackRecorderNode);

                trackRecorderNode.port.onmessage = (e) => {
                    if (signal.aborted) return;
                    trackBuffers[0].push(e.data.left);
                    trackBuffers[1].push(e.data.right);
                };

                stemPromises.push(new Promise(resolve => {
                    exportTimeoutId = setTimeout(() => {
                        if (signal.aborted) return resolve(null);

                        pannerNode.disconnect(trackRecorderNode);
                        trackRecorderNode.disconnect();

                        const wavBlob = exportWAV(trackBuffers, audioCtx.sampleRate);
                    
                        const prefix = isLooper ? `L${localIdx + 1}` : `A${localIdx + 1}`;
                        const instName = (document.getElementById(`inst-label-${i}`)?.textContent || 'Track').replace(/[^a-zA-Z0-9]/g, '_');
                        const typeLabel = studio.trackTypes[i] === 'drum' ? 'Drums' : 'Synth';
                        const fileName = `Track_${(i + 1).toString().padStart(2, '0')}_${prefix}_${typeLabel}_${instName}`;

                        audioFolder.file(`${fileName}.wav`, wavBlob);

                        tracksFinished++;
                        if (progressText) progressText.innerHTML = `Recording Stems... ${tracksFinished}/${tracksToProcess}`;
                    
                        resolve(i);
                    }, exportSec * 1000);
                }));
            }
        }

        // Trigger Real-time playback
        looper.isPlaying = arranger.isPlaying = true;
        looper.startTime = arranger.startTime = audioCtx.currentTime;
        if (hasLooperData) looper.lastPhases.fill(0);
        if (hasArrangerData) arranger.pauseTime = 0;
        updateStudioUI();

        // 8. Cleanup & Download
        const results = await Promise.all(stemPromises);
        if (signal.aborted) return;

        looper.isPlaying = arranger.isPlaying = false;
        masterGain.gain.value = prevVol;
        updateStudioUI();

        if (progressText) progressText.textContent = "Zipping audio stems...";

        const blob = await sessionZip.generateAsync({ type: "blob" });
        if (signal.aborted) return;

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);

        document.getElementById('export-panel')?.classList.add('hidden');
        showToast(`Exported ${tracksFinished} stems successfully!`);
        isExporting = false;
        if (isExportActive) toggleOverlay('export');
    });

    // --- Custom WAV Exporter to guarantee lossless native WAV export ---
    function exportWAV(buffers, sampleRate) {
        const numChannels = 2;
        // Hardened Length Calculation: handle both AudioBuffer objects and raw chunk arrays
        let totalFrameCount = 0;
        if (buffers[0] instanceof Float32Array) {
            totalFrameCount = buffers[0].length;
        } else {
            totalFrameCount = buffers[0].reduce((acc, b) => acc + b.length, 0);
        }

        const bytesPerSample = 2; // 16-bit PCM
        const blockAlign = numChannels * bytesPerSample;
        const dataSize = totalFrameCount * blockAlign;
        const headerSize = 44;
        const totalByteLength = headerSize + dataSize;

        const arrayBuffer = new ArrayBuffer(totalByteLength);
        const view = new DataView(arrayBuffer);

        const writeString = (v, offset, str) => {
            for (let i = 0; i < str.length; i++) {
                v.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        // RIFF Header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(view, 8, 'WAVE');
    
        // FMT Sub-chunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
    
        // Data Sub-chunk
        writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // Write PCM Data
        let offset = 44;
        const writeChunks = (left, right) => {
            for (let i = 0; i < left.length; i++) {
                // Clamp to [-1, 1] to prevent digital clipping/distortion
                let l = Math.max(-1, Math.min(1, left[i]));
                let r = Math.max(-1, Math.min(1, right[i]));
                // Convert to 16-bit PCM
                view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7FFF, true);
                offset += 2;
                view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
                offset += 2;
            }
        };

        if (buffers[0] instanceof Float32Array) {
            writeChunks(buffers[0], buffers[1]);
        } else {
            // Handle array of chunks (e.g. from AudioWorklet)
            for (let i = 0; i < buffers[0].length; i++) {
                writeChunks(buffers[0][i], buffers[1][i]);
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    // --- Piano Keyboard Generation ---
    function initPiano() {
        const container = document.getElementById('piano-overlay');
        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i <= 127; i++) {
            let note = i;
            let pc = note % 12;
            let isBlack = [1, 3, 6, 8, 10].includes(pc);
            let div = document.createElement('div');
            div.className = `piano-key ${isBlack ? 'black' : 'white'} highlightable`;
            div.dataset.note = note;
            div.style.display = 'none';

            let labelSpan = document.createElement('span');
            labelSpan.className = 'degree-label';
            labelSpan.style.display = 'none';
            div.appendChild(labelSpan);

            const startAction = () => { playMidiNote(note); };
            const stopAction = (forceInstant = false) => { stopMidiNote(note, forceInstant); };

            div._startAction = startAction;
            div._stopAction = stopAction;

            container.appendChild(div);
        }
    }

    function updatePianoVisuals() {
        document.querySelectorAll('.piano-key').forEach(key => {
            let note = parseInt(key.dataset.note);

            const shouldBeActive = playingMidiNotes.has(note);
            const isActive = key.classList.contains('active');
            if (shouldBeActive && !isActive) key.classList.add('active');
            else if (!shouldBeActive && isActive) key.classList.remove('active');

            const shouldBeExt = showExtensions && pianoExtensionNotes.has(note);
            const isExt = key.classList.contains('piano-ext-active');
            if (shouldBeExt && !isExt) key.classList.add('piano-ext-active');
            else if (!shouldBeExt && isExt) key.classList.remove('piano-ext-active');

            let degreeLabel = key.querySelector('.degree-label');
            if (degreeLabel) {
                if (showChordDegrees && currentIdentifiedRootPC !== null) {
                    let interval = (note - currentIdentifiedRootPC) % 12;
                    if (interval < 0) interval += 12;

                    const newText = degreeNames[interval];
                    if (degreeLabel.textContent !== newText) degreeLabel.textContent = newText;
                    if (degreeLabel.style.display !== 'block') degreeLabel.style.display = 'block';
                } else {
                    if (degreeLabel.style.display !== 'none') degreeLabel.style.display = 'none';
                }
            }
        });
    }
    initPiano();

    function releaseSustainedNotes() {
        sustainedVoices.forEach(nodeData => beginRelease(nodeData.voices));
        sustainedVoices.clear();
    }

    function scheduleArps() {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;

        const processNode = (nodeData) => {
            if (nodeData.type !== 'arp') return;
            while (nodeData.nextNoteTime < now + 0.1) {
                if (!currentArpLoop && nodeData.noteIndex >= nodeData.freqs.length) break;
                if (currentArpLoop && nodeData.noteIndex >= nodeData.freqs.length) nodeData.noteIndex = 0;

                if (nodeData.noteIndex < nodeData.freqs.length) {
                    const freq = nodeData.freqs[nodeData.noteIndex]; const index = nodeData.noteIndex;
                    let swingDelay = 0;
                    if (nodeData.freqs.length === 3) {
                        if (index % 3 === 1) swingDelay = nodeData.stepDuration * currentArpSwing * 0.5;
                        else if (index % 3 === 2) swingDelay = nodeData.stepDuration * currentArpSwing * 0.25;
                    } else {
                        const isUpbeat = index % 2 !== 0;
                        swingDelay = isUpbeat ? (nodeData.stepDuration * currentArpSwing * 0.6) : 0;
                    }

                    const startTime = nodeData.nextNoteTime + swingDelay;
                    const voice = spawnVoice(freq, startTime, index, nodeData.freqs.length, false, nodeData.synthState, nodeData.destination); // NEW: Arps now use their parent track's synth state!
                    voice.midiNote = Math.round(12 * Math.log2(freq / masterTune) + 69);
                    nodeData.voices.push(voice);
                    if (nodeData.voices.length > 30) {
                        const oldVoice = nodeData.voices.shift();
                        beginRelease([oldVoice], false); // Safely fade out the audio node!
                    }
                }
                nodeData.nextNoteTime += nodeData.stepDuration; nodeData.noteIndex++;
            }
        };
        activeNodes.forEach(processNode);
        sustainedVoices.forEach(processNode);
    }

    // --- Metronome Engine ---
    let nextMetroTime = 0;
    let metroStep = 0;

    function highlightDrumBtn(type, playTime) {
        if (!audioCtx) return;
        const timeToPlay = Math.max(0, playTime - audioCtx.currentTime);
        setTimeout(() => {
            const btn = document.querySelector(`.manual-drum-btn[data-drum="${type}"]`);
            if (btn) {
                btn.classList.add('active-btn');
                setTimeout(() => btn.classList.remove('active-btn'), 100);
            }
        }, timeToPlay * 1000);
    }

    function playDrum(type, time, velocity = 100, destination = null) { 
        if (midiOutMode === 'midi') return; 

        // =======================================================
        // --- AUTO-START RECORDING ON MANUAL HIT ---
        // =======================================================
        if (typeof looper !== 'undefined' && typeof arranger !== 'undefined' && typeof audioCtx !== 'undefined') {
            if (looper.isArmed || arranger.isArmed) {
                const now = audioCtx ? audioCtx.currentTime : 0;
                let stateChanged = false;
                if (looper.isArmed) { looper.isArmed = false; looper.isRecording = true; looper.isPlaying = true; looper.startTime = now; stateChanged = true; }
                if (arranger.isArmed) { arranger.isArmed = false; arranger.isRecording = true; arranger.isPlaying = true; arranger.startTime = now; stateChanged = true; }
                if (stateChanged && typeof updateStudioUI === 'function') updateStudioUI();
            }
        }

        // =======================================================
        // --- SMART ALIAS INTERCEPTOR (GENERAL MIDI FIX) ---
        // =======================================================
        // Ensure that imported MIDI files requesting obscure GM drums 
        // fallback to one of our 12 core synthesized equivalents.
        const coreDrums = ['kick', 'snare', 'hihat', 'clap', 'cymbal', 'tom1', 'tom2', 'tom3', 'cowbell', 'ride', 'rimshot', 'click'];
        
        let activeType = type;
        if (!coreDrums.includes(activeType)) {
            // It might be a raw MIDI note number passed as a string/int
            const midiNote = parseInt(activeType);
            if (!isNaN(midiNote) && typeof gmDrumMap !== 'undefined' && gmDrumMap[midiNote]) {
                activeType = gmDrumMap[midiNote].alias;
            } else {
                activeType = 'click'; // Ultimate fallback for unknown data
            }
        }

        // Normalize MIDI velocity (1-127) to Web Audio Gain (0.0-1.0). 
        // The fallback protects old data if a note was saved as a decimal. 
        const normVel = velocity > 1 ? velocity / 127.0 : Math.max(0.01, velocity); 

        // Hoist variables so the garbage collector can find them later 
        let osc = audioCtx.createOscillator(); 
        let osc2 = null; 
        let noise = null; 
        let filter = null; 
        const mainGain = audioCtx.createGain(); 

        // ======================================================= 
        // --- LIVE MONITORING FIX FOR DRUMS --- 
        // ======================================================= 
        let activeDest = destination; 
             
        // Dynamically route live pad hits through the active DAW track 
        if (!activeDest && typeof studio !== 'undefined') { 
            const activeDomain = studio.lastSelectedDomain; 
            const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack; 
                 
            // Only route to the track if it is ACTUALLY a drum track! 
            if (studio.trackTypes[activeIdx] === 'drum') { 
                activeDest = activeDomain === 'looper' ? looperGainNodes[activeIdx] : linearGainNodes[activeIdx - 8]; 
            } 
        } 

        // THE FIX: Bulletproof the fallback so it never bypasses the drum VCA
        let fallbackDest = null;
        if (typeof drumGain !== 'undefined' && drumGain) fallbackDest = drumGain;
        else if (typeof window.drumGain !== 'undefined' && window.drumGain) fallbackDest = window.drumGain;
        else if (typeof compressor !== 'undefined' && compressor) fallbackDest = compressor;
        
        const targetDest = activeDest || fallbackDest; 
        if (targetDest) mainGain.connect(targetDest); 

        // --- SYNTHESIS BLOCK (Now uses activeType instead of type) ---
        if (activeType === 'click' || activeType === 'snare') { 
            osc.type = 'square'; 
            osc.frequency.setValueAtTime(activeType === 'click' ? (normVel > 0.8 ? 1200 : 800) : 300, time); 
            osc.frequency.exponentialRampToValueAtTime(100, time + 0.05); 
            osc.connect(mainGain); 
            mainGain.gain.setValueAtTime(normVel, time); // Replaced velocity with normVel 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + (activeType === 'snare' ? 0.1 : 0.05)); 
            osc.start(time); osc.stop(time + 0.1); 
        } else if (activeType === 'kick') { 
            osc.type = 'sine'; 
            osc.frequency.setValueAtTime(150, time); 
            osc.frequency.exponentialRampToValueAtTime(0.001, time + 0.5); 
            osc.connect(mainGain); 
            mainGain.gain.setValueAtTime(normVel * 1.5, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 0.5); 
            osc.start(time); osc.stop(time + 0.5); 
        } else if (activeType === 'hihat' || activeType === 'cymbal') { 
            const bufferSize = audioCtx.sampleRate * (activeType === 'cymbal' ? 1.0 : 0.1); 
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate); 
            const data = buffer.getChannelData(0); 
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1; 

            noise = audioCtx.createBufferSource(); 
            noise.buffer = buffer; 
            filter = audioCtx.createBiquadFilter(); 
            filter.type = 'highpass'; 
            filter.frequency.value = activeType === 'cymbal' ? 5000 : 7000; 

            noise.connect(filter); filter.connect(mainGain); 

            mainGain.gain.setValueAtTime(normVel * 0.8, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + (activeType === 'cymbal' ? 1.0 : 0.1)); 
            noise.start(time); 
        } else if (activeType.startsWith('tom')) { 
            let freq = 150; 
            if (activeType === 'tom1') freq = 200; 
            if (activeType === 'tom2') freq = 130; 
            if (activeType === 'tom3') freq = 85; 
            osc.type = 'sine'; 
            osc.frequency.setValueAtTime(freq, time); 
            osc.frequency.exponentialRampToValueAtTime(freq * 0.3, time + 0.3); 
            osc.connect(mainGain); 
            mainGain.gain.setValueAtTime(normVel * 1.5, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 0.3); 
            osc.start(time); osc.stop(time + 0.3); 
        } else if (activeType === 'clap') { 
            const bufferSize = audioCtx.sampleRate * 0.2; 
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate); 
            const data = buffer.getChannelData(0); 
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1; 

            noise = audioCtx.createBufferSource(); 
            noise.buffer = buffer; 
            filter = audioCtx.createBiquadFilter(); 
            filter.type = 'bandpass'; 
            filter.frequency.value = 1200; filter.Q.value = 0.8; 

            noise.connect(filter); filter.connect(mainGain); 

            mainGain.gain.setValueAtTime(normVel * 1.5, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 0.2); 
            noise.start(time); 
        } else if (activeType === 'cowbell') { 
            osc2 = audioCtx.createOscillator(); 
            osc.type = 'square'; osc2.type = 'square'; 
            osc.frequency.setValueAtTime(800, time); 
            osc2.frequency.setValueAtTime(540, time); 
            osc.connect(mainGain); 
            osc2.connect(mainGain); 
            mainGain.gain.setValueAtTime(normVel * 0.6, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 0.2); 
            osc.start(time); osc.stop(time + 0.2); 
            osc2.start(time); osc2.stop(time + 0.2); 
        } else if (activeType === 'ride') { 
            const bufferSize = audioCtx.sampleRate * 1.5; 
            const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate); 
            const data = buffer.getChannelData(0); 
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1; 

            noise = audioCtx.createBufferSource(); 
            noise.buffer = buffer; 
            filter = audioCtx.createBiquadFilter(); 
            filter.type = 'bandpass'; 
            filter.frequency.value = 4000; filter.Q.value = 2; 

            noise.connect(filter); filter.connect(mainGain); 

            mainGain.gain.setValueAtTime(normVel * 0.5, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 1.5); 
            noise.start(time); 
        } else if (activeType === 'rimshot') { 
            osc.type = 'triangle'; 
            osc.frequency.setValueAtTime(800, time); 
            osc.frequency.exponentialRampToValueAtTime(200, time + 0.05); 
            osc.connect(mainGain); 
            mainGain.gain.setValueAtTime(normVel * 1.2, time); 
            mainGain.gain.exponentialRampToValueAtTime(0.001, time + 0.05); 
            osc.start(time); osc.stop(time + 0.05); 
        } 

        // Auto-Destruct Drum Nodes to save Mobile CPU 
        const tailMs = (activeType === 'cymbal' || activeType === 'ride') ? 2000 : 800; 
        setTimeout(() => { 
            try { 
                if (osc) osc.disconnect(); 
                if (osc2) osc2.disconnect(); 
                if (noise) noise.disconnect(); 
                if (filter) filter.disconnect(); 
                if (mainGain) mainGain.disconnect(); 
            } catch (e) { } 
        }, tailMs); 
    }

    function triggerSequencerDrum(type, playTime, velocity = 100) {
        playDrum(type, playTime, velocity);
        highlightDrumBtn(type, playTime);

        if (looper.isRecording || arranger.isRecording) {
            recordStudioEvent(null, 'drum', null, type, velocity, playTime);
        }
    }

    function scheduleMetronome() {
        if (!audioCtx) return;
        const metroMode = currentDrumPreset;
        if (metroMode === 'none') return;

        const now = audioCtx.currentTime;
        if (nextMetroTime === 0) nextMetroTime = now + 0.1;

        while (nextMetroTime < now + 0.1) {
            // Track both 16th notes (s) and 32nd notes (s32) for complex fills
            const stepDuration = (60 / currentArpBPM) / 4;
            const isUpbeat = metroStep % 2 !== 0;
            const swingDelay = isUpbeat ? (stepDuration * currentArpSwing * 0.6) : 0;
            const playTime = nextMetroTime + swingDelay;

            const s = metroStep % 16;
            const s32 = metroStep % 32;

            // --- Odd-Meter Trackers ---
            const s12 = metroStep % 12; // Used for 3/4 and 6/8
            const s20 = metroStep % 20; // Used for 5/4
            const s14 = metroStep % 14; // Used for 7/8

            if (looper.isArmed) { looper.isArmed = false; looper.isRecording = true; looper.isPlaying = true; looper.startTime = playTime; looper.recordingType = 'drum'; updateStudioUI(); }
            else if (looper.isRecording && looper.recordingType !== 'both') { if (looper.recordingType === 'voice') { looper.recordingType = 'both'; updateStudioUI(); } }

            // --- 'METRONOME' PRESETS ---
            if (metroMode === 'click') {
                if (s % 4 === 0) triggerSequencerDrum('click', playTime, s === 0 ? 100 : 50);
            }
            else if (metroMode === 'basic') {
                if (s === 0 || s === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s % 4 === 0) triggerSequencerDrum('hihat', playTime, 30);
            }
            else if (metroMode === 'rock') {
                if (s === 0 || s === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, (s % 4 === 0) ? 50 : 20); // Accented 8th notes
                if (s === 0 && metroStep % 64 === 0) triggerSequencerDrum('cymbal', playTime, 80);
            }
            // --- GARAGE ROCK (Loose, tom-heavy, aggressive) ---
            else if (metroMode === 'garage') {
                if (s === 0 || s === 7 || s === 10) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 14 || s === 15) triggerSequencerDrum('snare', playTime, 40); // Snare ghost rolls
                if (s % 4 === 0) triggerSequencerDrum('ride', playTime, 70);
                if (s === 6) triggerSequencerDrum('tom2', playTime, 60);
                if (s === 8) triggerSequencerDrum('tom3', playTime, 80);
            }
            // --- METAL (Double kick, blast beats, heavy cymbals) ---
            else if (metroMode === 'metal') {
                if (s % 2 === 0) triggerSequencerDrum('kick', playTime, 90); // Constant double bass
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s % 4 === 0) triggerSequencerDrum('cymbal', playTime, 60); // Riding the crash
                if (s32 === 30 || s32 === 31) triggerSequencerDrum('kick', playTime, 100); // 32nd note kick gallop at the end of the bar
            }
            // --- PUNK (Fast, syncopated snare, driving hi-hats) ---
            else if (metroMode === 'punk') {
                if (s === 0 || s === 6 || s === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s === 2 || s === 10 || s === 14) triggerSequencerDrum('snare', playTime, 100); // Anti-beat snare
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
                if (s === 0 && metroStep % 32 === 0) triggerSequencerDrum('cymbal', playTime, 80);
            }
            else if (metroMode === 'swing') {
                if (s === 0 || s === 4 || s === 8 || s === 12) triggerSequencerDrum('ride', playTime, 80);
                if (s === 3 || s === 7 || s === 11 || s === 15) triggerSequencerDrum('ride', playTime, 50); // The "spang-a-lang"
                if (s === 4 || s === 12) triggerSequencerDrum('hihat', playTime, 80); // Hi-hat on 2 and 4
                if (s === 10) triggerSequencerDrum('snare', playTime, 30); // Comping snare ghost note
            }
            else if (metroMode === 'house') {
                if (s === 0 || s === 4 || s === 8 || s === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('clap', playTime, 100);
                if (s === 2 || s === 6 || s === 10 || s === 14) triggerSequencerDrum('hihat', playTime, 80); // Off-beat open hat
                if (s === 15) triggerSequencerDrum('hihat', playTime, 30); // closed hat groove
            }
            // --- DISCO (Four-on-the-floor with driving 16th hi-hats) ---
            else if (metroMode === 'disco') {
                if (s % 4 === 0) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                triggerSequencerDrum('hihat', playTime, (s % 4 === 2) ? 90 : 40); // 16th hats, heavily accented on the off-beat
            }
            else if (metroMode === 'techno') {
                if (s === 0 || s === 4 || s === 8 || s === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s === 2 || s === 6 || s === 10 || s === 14) triggerSequencerDrum('hihat', playTime, 80);
                if (s === 15) triggerSequencerDrum('rimshot', playTime, 80);
                if (s === 7 || s === 11) triggerSequencerDrum('tom1', playTime, 50); // Minimalist rolling toms
            }
            else if (metroMode === 'breakbeat') {
                if (s === 0 || s === 5 || s === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 7 || s === 14) triggerSequencerDrum('snare', playTime, 30); // The Amen-break ghost snares
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, (s % 4 === 0) ? 60 : 30);
            }
            else if (metroMode === 'dnb') {
                if (s === 0 || s === 9) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 14) triggerSequencerDrum('kick', playTime, 70); // The classic DnB turnaround
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'reggae') {
                // One-drop groove
                if (s === 4 || s === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('rimshot', playTime, 100);
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
                if (s === 14) triggerSequencerDrum('tom2', playTime, 70);
            }
            else if (metroMode === 'reggaeton') {
                // Dembow rhythm
                if (s === 0 || s === 4 || s === 8 || s === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s === 3 || s === 6 || s === 11 || s === 14) triggerSequencerDrum('snare', playTime, 100);
            }
            else if (metroMode === 'trap') {
                if (s === 0 || s === 8 || s === 11) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('clap', playTime, 100);
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
                if (s === 14 || s === 15) triggerSequencerDrum('hihat', playTime, 40);
                if (s32 === 14 || s32 === 15) triggerSequencerDrum('hihat', playTime, 30); // 32nd note hi-hat rolls
            }
            // --- LO-FI (Dilla-style swing, laid back, off-grid feel) ---
            else if (metroMode === 'lofi') {
                // Kick is intentionally slightly late/lazy on the 8
                if (s === 0) triggerSequencerDrum('kick', playTime, 100);
                if (s === 9) triggerSequencerDrum('kick', playTime + 0.02, 80);
                if (s === 4 || s === 12) triggerSequencerDrum('rimshot', playTime, 100);
                triggerSequencerDrum('hihat', playTime, (s % 4 === 0) ? 70 : 30); // Unquantized 16ths feel
            }
            else if (metroMode === 'bossa') {
                if (s === 0 || s === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s === 7 || s === 15) triggerSequencerDrum('kick', playTime, 50); // Soft turnaround kicks
                if ([0, 3, 6, 10, 13].includes(s)) triggerSequencerDrum('rimshot', playTime, 100); // Clave
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }
            else if (metroMode === 'funk') {
                if (s === 0 || s === 7 || s === 10) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 9 || s === 14) triggerSequencerDrum('snare', playTime, 30); // Ghost notes
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
                if (s === 2 || s === 6) triggerSequencerDrum('cowbell', playTime, 60);
            }
            // --- NEW: AFROBEAT (Complex polyrhythms, heavy percussion) ---
            else if (metroMode === 'afrobeat') {
                if (s === 0 || s === 8 || s === 11) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 2 || s === 7 || s === 14) triggerSequencerDrum('rimshot', playTime, 80);
                if (s === 6) triggerSequencerDrum('tom1', playTime, 70);
                if (s === 10) triggerSequencerDrum('tom2', playTime, 70);
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }
            else if (metroMode === 'hiphop') {
                if (s === 0 || s === 9 || s === 11) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s === 14) triggerSequencerDrum('snare', playTime, 30); // Ghost note
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'rnb') {
                if (s === 0 || s === 11) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('clap', playTime, 100);
                if (s % 4 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }
            else if (metroMode === 'latin') {
                if (s === 0 || s === 6 || s === 10) triggerSequencerDrum('kick', playTime, 80);
                if ([0, 3, 6, 10, 12].includes(s)) triggerSequencerDrum('cowbell', playTime, 100); // Clave
                if (s === 4) triggerSequencerDrum('tom1', playTime, 70); // Conga High
                if (s === 8) triggerSequencerDrum('tom3', playTime, 80); // Conga Low
                if (s === 14) triggerSequencerDrum('tom2', playTime, 80); // Conga Mid
                if (s % 4 === 0) triggerSequencerDrum('ride', playTime, 50);
            }
            else if (metroMode === 'synthwave') {
                if (s % 4 === 0) triggerSequencerDrum('kick', playTime, 100);
                if (s === 4 || s === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 60); // Straight 8ths
                // Big 80s tom fill at the end of every 2 bars
                if (metroStep % 32 > 24) {
                    if (s === 10) triggerSequencerDrum('tom1', playTime, 80);
                    if (s === 12) triggerSequencerDrum('tom2', playTime, 80);
                    if (s === 14) triggerSequencerDrum('tom3', playTime, 90);
                }
            }
            else if (metroMode === 'drill') {
                if (s === 0 || s === 5 || s === 10) triggerSequencerDrum('kick', playTime, 100);
                if (s === 6 || s === 14) triggerSequencerDrum('snare', playTime, 100); // Halftime snare placement
                if (s % 2 === 0) triggerSequencerDrum('hihat', playTime, 70); // Base 8ths
                // Fast 32nd note hi-hat rolls (trills)
                if (s32 === 6 || s32 === 7 || s32 === 26 || s32 === 27 || s32 === 28 || s32 === 29) {
                    triggerSequencerDrum('hihat', playTime, 40);
                }
            }

            // ==========================================
            // --- 3/4 TIME GROOVES (12 steps per bar) ---
            // ==========================================
            else if (metroMode === 'waltz') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 4 || s12 === 8) triggerSequencerDrum('snare', playTime, 70); // Beats 2 and 3
                if (s12 % 4 === 0) triggerSequencerDrum('hihat', playTime, 50); // Quarter notes
            }
            else if (metroMode === 'jazz34') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 60);
                if (s12 === 0 || s12 === 4 || s12 === 8) triggerSequencerDrum('ride', playTime, 80);
                if (s12 === 3 || s12 === 7 || s12 === 11) triggerSequencerDrum('ride', playTime, 40); // Spang-a-lang in 3
                if (s12 === 4 || s12 === 8) triggerSequencerDrum('hihat', playTime, 70); // Hat pedal
            }
            else if (metroMode === 'pop34') {
                if (s12 === 0 || s12 === 6) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 4 || s12 === 8) triggerSequencerDrum('snare', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'lofi34') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 6) triggerSequencerDrum('kick', playTime + 0.02, 60); // Lazy 8th
                if (s12 === 4 || s12 === 8) triggerSequencerDrum('rimshot', playTime, 90);
                if (s12 === 0 || s12 === 4 || s12 === 8) triggerSequencerDrum('hihat', playTime, 60);
            }
            else if (metroMode === 'minuet') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 80);
                if (s12 === 4) triggerSequencerDrum('snare', playTime, 60);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }
            else if (metroMode === 'rock34') {
                if (s12 === 0 || s12 === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 4) triggerSequencerDrum('snare', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('cymbal', playTime, 60);
            }
            else if (metroMode === 'rnb34') {
                if (s12 === 0 || s12 === 7) triggerSequencerDrum('kick', playTime, 90);
                if (s12 === 4 || s12 === 8) triggerSequencerDrum('clap', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'folk34') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 80);
                if (s12 === 4) triggerSequencerDrum('tom2', playTime, 70);
                if (s12 === 8) triggerSequencerDrum('tom3', playTime, 70);
                if (s12 % 4 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }

            // ==========================================
            // --- 6/8 TIME GROOVES (12 steps, Accents on 1 and 4) ---
            // ==========================================
            else if (metroMode === 'blues68') {
                if (s12 === 0 || s12 === 6) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 6) triggerSequencerDrum('snare', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, (s12 === 0 || s12 === 6) ? 80 : 40);
            }
            else if (metroMode === 'rock68') {
                if (s12 === 0 || s12 === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 6) triggerSequencerDrum('snare', playTime, 100);
                if (s12 === 0) triggerSequencerDrum('cymbal', playTime, 70);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'afro68') {
                if (s12 === 0 || s12 === 6) triggerSequencerDrum('kick', playTime, 90);
                if (s12 === 0 || s12 === 3 || s12 === 6 || s12 === 9) triggerSequencerDrum('rimshot', playTime, 100); // 6/8 Clave
                if (s12 === 4) triggerSequencerDrum('tom1', playTime, 80);
                if (s12 === 10) triggerSequencerDrum('tom3', playTime, 80);
            }
            else if (metroMode === 'rnb68') {
                if (s12 === 0 || s12 === 3) triggerSequencerDrum('kick', playTime, 80);
                if (s12 === 6) triggerSequencerDrum('snare', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'shanty') {
                if (s12 === 0 || s12 === 6) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 6) triggerSequencerDrum('clap', playTime, 100);
            }
            else if (metroMode === 'pop68') {
                if (s12 === 0 || s12 === 9) triggerSequencerDrum('kick', playTime, 90);
                if (s12 === 6) triggerSequencerDrum('snare', playTime, 100);
                if (s12 % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
            }
            else if (metroMode === 'trap68') {
                if (s12 === 0 || s12 === 6 || s12 === 9) triggerSequencerDrum('kick', playTime, 100);
                if (s12 === 6) triggerSequencerDrum('clap', playTime, 100);
                triggerSequencerDrum('hihat', playTime, 50); // 16th notes rolling
            }
            else if (metroMode === 'lofi68') {
                if (s12 === 0) triggerSequencerDrum('kick', playTime, 90);
                if (s12 === 6) triggerSequencerDrum('rimshot', playTime, 90);
                if (s12 === 2 || s12 === 4 || s12 === 8 || s12 === 10) triggerSequencerDrum('hihat', playTime, 40); // Offbeats
            }

            // ==========================================
            // --- 5/4 TIME GROOVES (20 steps per bar) ---
            // ==========================================
            else if (metroMode === 'take5') {
                // Classic 3+2 Jazz phrasing
                if (s20 === 0 || s20 === 12) triggerSequencerDrum('kick', playTime, 80); // Beat 1 and 4
                if (s20 === 0 || s20 === 4 || s20 === 8 || s20 === 12 || s20 === 16) triggerSequencerDrum('ride', playTime, 80);
                if (s20 === 3 || s20 === 7 || s20 === 11 || s20 === 15 || s20 === 19) triggerSequencerDrum('ride', playTime, 40);
                if (s20 === 4 || s20 === 16) triggerSequencerDrum('hihat', playTime, 80); // Hat pedal
            }
            else if (metroMode === 'prog54') {
                if (s20 === 0 || s20 === 6 || s20 === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s20 === 8 || s20 === 16) triggerSequencerDrum('snare', playTime, 100); // Snare on beat 3 and 5
                if (s20 % 2 === 0) triggerSequencerDrum('cymbal', playTime, 50);
            }
            else if (metroMode === 'pop54') {
                if (s20 === 0 || s20 === 8 || s20 === 12) triggerSequencerDrum('kick', playTime, 90);
                if (s20 === 4 || s20 === 16) triggerSequencerDrum('snare', playTime, 100);
                if (s20 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'funk54') {
                if (s20 === 0 || s20 === 10 || s20 === 14) triggerSequencerDrum('kick', playTime, 100);
                if (s20 === 4 || s20 === 12) triggerSequencerDrum('snare', playTime, 100);
                if (s20 % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
            }
            else if (metroMode === 'mission') {
                // The classic 3+3+2+2 spy theme groove
                if (s20 === 0 || s20 === 6 || s20 === 12 || s20 === 16) triggerSequencerDrum('kick', playTime, 90);
                if (s20 === 16) triggerSequencerDrum('snare', playTime, 100);
                if (s20 % 4 === 0) triggerSequencerDrum('ride', playTime, 70);
            }
            else if (metroMode === 'lofi54') {
                if (s20 === 0 || s20 === 12) triggerSequencerDrum('kick', playTime, 90);
                if (s20 === 8 || s20 === 16) triggerSequencerDrum('rimshot', playTime, 100);
                if (s20 % 4 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'elec54') {
                if (s20 % 4 === 0) triggerSequencerDrum('kick', playTime, 90); // 4-on-the-floor in 5
                if (s20 === 8 || s20 === 16) triggerSequencerDrum('clap', playTime, 100);
                if (s20 % 2 === 0 && s20 % 4 !== 0) triggerSequencerDrum('hihat', playTime, 70); // Offbeats
            }
            else if (metroMode === 'afro54') {
                if (s20 === 0 || s20 === 12) triggerSequencerDrum('kick', playTime, 90);
                if (s20 === 0 || s20 === 3 || s20 === 6 || s20 === 12 || s20 === 15) triggerSequencerDrum('rimshot', playTime, 100);
                if (s20 % 2 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }

            // ==========================================
            // --- 7/8 TIME GROOVES (14 steps per bar) ---
            // ==========================================
            else if (metroMode === 'money78') {
                // Classic 4+3 feel
                if (s14 === 0 || s14 === 4 || s14 === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s14 === 4 || s14 === 10) triggerSequencerDrum('snare', playTime, 100);
                if (s14 % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
            }
            else if (metroMode === 'prog78') {
                if (s14 === 0 || s14 === 6) triggerSequencerDrum('kick', playTime, 100);
                if (s14 === 4 || s14 === 10) triggerSequencerDrum('snare', playTime, 100);
                if (s14 % 2 === 0) triggerSequencerDrum('cymbal', playTime, 50);
            }
            else if (metroMode === 'balkan78') {
                // Classic 3+2+2 feel
                if (s14 === 0 || s14 === 6 || s14 === 10) triggerSequencerDrum('kick', playTime, 90);
                if (s14 === 2 || s14 === 8 || s14 === 12) triggerSequencerDrum('tom1', playTime, 60);
            }
            else if (metroMode === 'fusion78') {
                if (s14 === 0 || s14 === 8) triggerSequencerDrum('kick', playTime, 100);
                if (s14 === 4 || s14 === 10) triggerSequencerDrum('snare', playTime, 100);
                if (s14 % 2 === 0) triggerSequencerDrum('ride', playTime, 70);
            }
            else if (metroMode === 'funk78') {
                if (s14 === 0 || s14 === 10 || s14 === 12) triggerSequencerDrum('kick', playTime, 100);
                if (s14 === 4 || s14 === 8) triggerSequencerDrum('snare', playTime, 100);
                if (s14 % 2 === 0) triggerSequencerDrum('hihat', playTime, 60);
            }
            else if (metroMode === 'lofi78') {
                if (s14 === 0 || s14 === 6) triggerSequencerDrum('kick', playTime, 90);
                if (s14 === 4 || s14 === 10) triggerSequencerDrum('rimshot', playTime, 100);
                if (s14 % 4 === 0) triggerSequencerDrum('hihat', playTime, 40);
            }
            else if (metroMode === 'elec78') {
                if (s14 === 0 || s14 === 4 || s14 === 8 || s14 === 10) triggerSequencerDrum('kick', playTime, 90);
                if (s14 === 10) triggerSequencerDrum('clap', playTime, 100);
                if (s14 % 2 === 0) triggerSequencerDrum('hihat', playTime, 50);
            }
            else if (metroMode === 'jazz78') {
                if (s14 === 0) triggerSequencerDrum('kick', playTime, 70);
                if (s14 === 10) triggerSequencerDrum('snare', playTime, 80);
                if (s14 === 0 || s14 === 4 || s14 === 8 || s14 === 10) triggerSequencerDrum('ride', playTime, 80);
            }

            // --- EMBELLISHMENTS / PROCEDURAL FILLS (THE "DRUMMER AI") ---
            if (currentDrumFills > 0) {
                // 1. Dynamic Phrase Math (A standard musical phrase is 4 bars)
                const stepsPerBar = beatsPerBar * 4;
                const phraseLength = stepsPerBar * 4;
            
                // Which step of the individual bar are we on? (0 to stepsPerBar - 1)
                const barStep = metroStep % stepsPerBar; 
            
                // Are we in the final bar of the 4-bar phrase?
                const isBar4 = (metroStep % phraseLength) >= (phraseLength - stepsPerBar);
            
                // Are we on the exact downbeat (the very first step) of a new 4-bar phrase?
                const isPhraseDownbeat = (barStep === 0 && metroStep % phraseLength === 0);

                // 2. GHOST NOTES (Snare buzzes & hi-hat variations)
                // These apply globally across all time signatures on odd 16th notes
                if (barStep % 2 !== 0 && Math.random() < (currentDrumFills * 0.35)) {
                    triggerSequencerDrum('snare', playTime, 15 + (Math.random() * 15));
                }
            
                // Slightly open hat before the downbeat of the next bar
                if (barStep === stepsPerBar - 2 && Math.random() < currentDrumFills) {
                    triggerSequencerDrum('hihat', playTime, 60); 
                }

                // 3. STRUCTURAL FILLS (Only happens at the end of the 4-bar phrase)
                if (isBar4) {
                    // The "Fill Zone" is the final beat of the bar (the last 4 steps)
                    const fillZoneStart = stepsPerBar - 4;
                
                    // Medium Fills (> 30% Intensity): 1-beat fill on the final beat
                    if (currentDrumFills >= 0.3 && barStep >= fillZoneStart) {
                        const fillStep = barStep - fillZoneStart; // Normalizes to 0, 1, 2, 3
                    
                        if (fillStep === 0) triggerSequencerDrum(Math.random() > 0.5 ? 'snare' : 'tom1', playTime, 80);
                        if (fillStep === 1) triggerSequencerDrum('tom1', playTime, 70);
                        if (fillStep === 2) triggerSequencerDrum('tom2', playTime, 80);
                        if (fillStep === 3) triggerSequencerDrum('tom3', playTime, 90);
                    }

                    // Heavy Fills (> 70% Intensity): Extends the fill to cover the final TWO beats
                    const heavyFillZoneStart = stepsPerBar - 8;
                    if (currentDrumFills >= 0.7 && barStep >= heavyFillZoneStart && barStep < fillZoneStart) {
                        const fillStep = barStep - heavyFillZoneStart; // Normalizes to 0, 1, 2, 3
                    
                        if (fillStep === 0 || fillStep === 2) triggerSequencerDrum('snare', playTime, 90);
                        if (fillStep === 1 || fillStep === 3) triggerSequencerDrum('kick', playTime, 80);
                    }
                }

                // 4. CYMBAL CRASHES
                // Hit the crash on the "1" of a new 4-bar section (only if intensity > 40%)
                if (isPhraseDownbeat && currentDrumFills >= 0.4) {
                    triggerSequencerDrum('cymbal', playTime, 50 + (currentDrumFills * 40));
                }
            }

            nextMetroTime += stepDuration;
            metroStep++;
        }
    }

    function triggerManualDrum(type, velocity = 100) { // Default adjusted to 100 here as well
        initAudio();
    
        let activeDomain = studio.lastSelectedDomain;
        let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        let destNode = activeDomain === 'looper' ? looperGainNodes[activeIdx] : linearGainNodes[activeIdx - 8];
    
        playDrum(type, audioCtx.currentTime, velocity, destNode);

        // --- STEP ENTRY DRUM INTERCEPT ---
        if (typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
            handleStepEntry(null, null, type, velocity);
            // Drums don't have a "release" state like keyboards, so we instantly auto-advance!
            advanceStepCursor(); 
        
            const b = document.querySelector(`.manual-drum-btn[data-drum="${type}"]`);
            if (b) { b.classList.add('active-btn'); setTimeout(() => b.classList.remove('active-btn'), 100); }
            return; // Skip standard live-recording logic
        }

        // Check if either engine is armed BEFORE processing
        let wasArmed = looper.isArmed || arranger.isArmed;

        if (looper.isArmed) {
            looper.isArmed = false; looper.isRecording = true; looper.isPlaying = true; looper.startTime = audioCtx.currentTime; 
        } else if (looper.isRecording && looper.recordingType !== 'both') {
            // Note: updateLooperUI() was a legacy function name. It should be updateStudioUI()
            if (looper.recordingType === 'voice') { looper.recordingType = 'both'; }
        }

        if (arranger.isArmed) {
            arranger.isArmed = false; arranger.isRecording = true; arranger.isPlaying = true; arranger.startTime = audioCtx.currentTime; 
        }
    
        if (wasArmed) {
            // --- NEW: THE METRONOME PHASE SNAP ---
            metronomeBeatCount = 0;
            nextMetronomeTick = audioCtx.currentTime + (60 / currentArpBPM); 
            playClick(audioCtx.currentTime, true); // Force an instant accent click
        
            if (metronomeMode === 1) isMetronomePlaying = false; // Auto-stop Count-In
        
            updateStudioUI();
        }

        if (looper.isRecording || arranger.isRecording) {
            recordStudioEvent(null, 'drum', null, type, velocity, audioCtx.currentTime);
        }

        const btn = document.querySelector(`.manual-drum-btn[data-drum="${type}"]`);
        if (btn) {
            btn.classList.add('active-btn');
            setTimeout(() => btn.classList.remove('active-btn'), 100);
        }
    }

    document.querySelectorAll('.manual-drum-btn').forEach(btn => {
        const type = btn.dataset.drum;
        btn._startAction = () => { wakeNav(); triggerManualDrum(type); };
        btn._stopAction = () => { };
        btn.classList.add('highlightable');
    });

    // =====================================================================
    // UNTHROTTLED WEB WORKER CLOCK (Prevents Sequencer Drift in Background)
    // =====================================================================
    const workerCode = `
        let timerID = null;
        self.onmessage = function(e) {
            if (e.data === 'start') {
                timerID = setInterval(() => self.postMessage('tick'), 25);
            } else if (e.data === 'stop') {
                clearInterval(timerID);
            }
        };
    `;

    // Boot the background worker
    const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
    const engineClockWorker = new Worker(URL.createObjectURL(workerBlob));

engineClockWorker.onmessage = function () {
        if (typeof scheduleArps === 'function') scheduleArps();
        if (typeof scheduleMetronome === 'function') scheduleMetronome(); // Keeps the drum AI ticking
        if (typeof scheduleClickTrack === 'function') scheduleClickTrack(); // Keeps the metronome click track ticking!
        if (typeof processStudioPlayback === 'function') processStudioPlayback();

        // --- MIDI MASTER CLOCK SENDER ---
        if (midiSyncMode === 'master' && midiOut && audioCtx) {
            const now = audioCtx.currentTime;
            if (now > 0) {
                const pulseInterval = (60 / currentArpBPM) / 24; // 24 pulses per quarter note
                if (nextMidiPulseTime === 0) nextMidiPulseTime = now + 0.1;

                // Lookahead schedule for MIDI clock (prevents javascript timer jitter)
                while (nextMidiPulseTime < now + 0.1) {
                    const timeToStart = Math.max(0, nextMidiPulseTime - now);
                    setTimeout(() => { if (midiOut) midiOut.send([248]); }, timeToStart * 1000);
                    nextMidiPulseTime += pulseInterval;
                }
            }
        }

        if ((isArpOn() && activeNodes.size > 0) || looper.isPlaying) {
            highlightUpdatePending = false;
            if (typeof updateHighlights === 'function') updateHighlights();
        }
    };

    // Start the clock!
    engineClockWorker.postMessage('start');


    // ==========================================
    // 3. MIDI INTEGRATION
    // ==========================================
    let midiAccess = null; let midiOut = null; const midiActiveNotes = new Map();
    let midiSyncMode = 'off'; // 'off', 'master', or 'slave'
    let clockPulses = []; // Tracks incoming slave pulses
    let nextMidiPulseTime = 0; // Tracks outgoing master pulses

    document.getElementById('btnMidi')?.addEventListener('click', (e) => {
        const btn = document.getElementById('btnMidi');
        const btnOut = document.getElementById('btnMidiOutput');
        const syncMode = document.getElementById('midiSyncMode');

        if (midiAccess) {
            const inputs = midiAccess.inputs.values();
            for (let input = inputs.next(); input && !input.done; input = inputs.next()) input.value.onmidimessage = null;
            midiAccess = null; midiOut = null; midiActiveNotes.clear();

            if (btn) { btn.textContent = "Connect MIDI"; btn.classList.remove('active-btn'); }
            // Lock the UI back down on disconnect
            if (btnOut) { btnOut.disabled = true; btnOut.style.opacity = '0.5'; btnOut.textContent = 'BROWSER ONLY'; }
            if (syncMode) { syncMode.disabled = true; syncMode.style.opacity = '0.5'; syncMode.value = 'off'; syncMode.dispatchEvent(new Event('change')); }
            return;
        }
        if (navigator.requestMIDIAccess) {
            try {
                navigator.requestMIDIAccess()
                    .then(onMIDISuccess)
                    .catch(err => {
                        console.warn("MIDI Promise Rejected:", err);
                        if (btn) { btn.textContent = "MIDI: Access Denied"; btn.classList.remove('active-btn'); }
                    });
            } catch (err) {
                console.error("MIDI Sync Crash Blocked:", err);
                if (btn) { btn.textContent = "MIDI: OS Blocked"; btn.classList.remove('active-btn'); }
            }
        } else {
            if (btn) { btn.textContent = "Web MIDI not supported"; btn.classList.remove('active-btn'); }
        }
    });

    function onMIDISuccess(midi) {
        midiAccess = midi;
        const inputs = midiAccess.inputs.values(); let connectedInputs = 0;
        for (let input = inputs.next(); input && !input.done; input = inputs.next()) { input.value.onmidimessage = onMIDIMessage; connectedInputs++; }
        const outputs = midiAccess.outputs.values();
        for (let output = outputs.next(); output && !output.done; output = outputs.next()) { midiOut = output.value; break; }

        const btn = document.getElementById('btnMidi');
        const btnOut = document.getElementById('btnMidiOutput');
        const syncMode = document.getElementById('midiSyncMode');

        if (connectedInputs > 0 || midiOut) {
            if (btn) { btn.textContent = "Disconnect MIDI"; btn.classList.add('active-btn'); }
            // Wake the UI up!
            if (btnOut) { btnOut.disabled = false; btnOut.style.opacity = '1'; btnOut.textContent = midiOutMode === 'both' ? 'MIDI OUT: MIDI + BROWSER' : 'MIDI OUT: MIDI ONLY'; }
            if (syncMode) { syncMode.disabled = false; syncMode.style.opacity = '1'; }
        } else {
            if (btn) { btn.textContent = "MIDI: No Devices Found"; btn.classList.remove('active-btn'); }
            midiAccess = null;
        }
    }

    function onMIDIMessage(message) {
        const [status, data1, data2] = message.data;

        // --- MIDI CLOCK SYNC (SLAVE MODE) ---
        if (midiSyncMode === 'slave') {
            if (status === 248) { // 0xF8 Timing Clock (24 times per beat)
                const now = performance.now();
                clockPulses.push(now);
                if (clockPulses.length > 24) clockPulses.shift();

                if (clockPulses.length === 24) {
                    // Calculate exact BPM based on the time it took to receive 24 pulses
                    const elapsed = now - clockPulses[0];
                    const bpm = Math.round(60000 / elapsed);
                    if (bpm !== currentArpBPM && bpm >= 40 && bpm <= 240) {
                        currentArpBPM = bpm;
                        const bpmSlider = document.getElementById('arpBpm');
                        if (bpmSlider) bpmSlider.value = bpm;
                        updateLabel('arpBpm', bpm, 'Arp/Metron', ' BPM');
                    }
                }
                return; // Don't process clock ticks as notes
            }
            else if (status === 250 || status === 251) { // 0xFA Start or 0xFB Continue
                // Hard-reset the internal phase grid to perfectly lock the downbeat!
                nextMetroTime = audioCtx ? audioCtx.currentTime : 0;
                metroStep = 0;
                if (looper.isPlaying) looper.startTime = nextMetroTime;
                activeNodes.forEach(n => { if (n.type === 'arp') n.nextNoteTime = nextMetroTime; });
                return;
            }
            else if (status === 252) { // 0xFC Stop
                // Optional: You could stop the looper here if desired
                return;
            }
        }

        // --- STANDARD MIDI NOTES ---
        const command = status >> 4; const note = data1; const velocity = data2;
        
        if (command === 9 && velocity > 0) { 
            midiActiveNotes.set(note, velocity); 
            playMidiNote(note); 
        }
        else if (command === 8 || (command === 9 && velocity === 0)) { 
            midiActiveNotes.delete(note); 
            stopMidiNote(note); 
        }
        // --- MOD WHEEL INTERCEPT ---
        else if (command === 11 && note === 1) {
            setModWheel(velocity / 127.0); // Map 0-127 MIDI value to 0.0-1.0 float
        }
        // --- SUSTAIN PEDAL ---
        else if (command === 11 && note === 64) {
            if (velocity > 63 && !sustainLocked) { 
                sustainLocked = true; 
                const lS = document.getElementById('lockSustain'); 
                if (lS) lS.classList.add('active-btn'); 
                updatePadVisuals(); 
            }
            else if (velocity <= 63 && sustainLocked) { 
                sustainLocked = false; 
                const lS = document.getElementById('lockSustain'); 
                if (lS) lS.classList.remove('active-btn'); 
                checkSustainRelease(); 
                updatePadVisuals(); 
            }
        }
    }

    const midiDummyElements = new Map();
    function playMidiNote(midiNote) {
        if (!midiDummyElements.has(midiNote)) {
            const dummy = { _st: [midiNote], isMidi: true };
            midiDummyElements.set(midiNote, dummy);
            const freq = masterTune * Math.pow(2, (midiNote - 69) / 12);
            playFrequencies(dummy, [freq], [midiNote]);
        }
    }
    function stopMidiNote(midiNote, forceInstant = false) {
        if (midiDummyElements.has(midiNote)) {
            stopFrequencies(midiDummyElements.get(midiNote), forceInstant);
            midiDummyElements.delete(midiNote);
        }
    }

    // ==========================================
    // 4. MUSIC THEORY LOGIC (Labels & Scales)
    // ==========================================
    const labelAbsoluteFlat = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
    const labelAbsoluteSharp = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const labelSolfege = ["Do", "Ra", "Re", "Me", "Mi", "Fa", "Fi", "Sol", "Le", "La", "Te", "Ti"];
    const labelDegreesFlat = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"];
    const labelDegreesSharp = ["1", "#1", "2", "#2", "3", "4", "#4", "5", "#5", "6", "#6", "7"];
    const labelRomanFlat = ["I", "bII", "II", "bIII", "III", "IV", "bV", "V", "bVI", "VI", "bVII", "VII"];
    const labelRomanSharp = ["I", "#I", "II", "#II", "III", "IV", "#IV", "V", "#V", "VI", "#VI", "VII"];

    const scaleMasks = {
        // Standard & Modes
        'all': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        'major': [0, 2, 4, 5, 7, 9, 11],
        'minor': [0, 2, 3, 5, 7, 8, 10],
        'dorian': [0, 2, 3, 5, 7, 9, 10],
        'phrygian': [0, 1, 3, 5, 7, 8, 10],
        'lydian': [0, 2, 4, 6, 7, 9, 11],
        'mixolydian': [0, 2, 4, 5, 7, 9, 10],
        'locrian': [0, 1, 3, 5, 6, 8, 10],
        
        // Minor Variations
        'harmonic': [0, 2, 3, 5, 7, 8, 11],
        'melodic': [0, 2, 3, 5, 7, 9, 11],
        'dorian_b2': [0, 1, 3, 5, 7, 9, 10],        // 2nd mode of melodic minor
        'locrian_nat2': [0, 2, 3, 5, 6, 8, 10],     // 6th mode of melodic minor (Half-Diminished)
        'neapolitan_min': [0, 1, 3, 5, 7, 8, 11],
        'neapolitan_maj': [0, 1, 3, 5, 7, 9, 11],
        'hungarian': [0, 2, 3, 6, 7, 8, 11],
        'ukrainian': [0, 2, 3, 6, 7, 9, 10],

        // Pentatonic & Blues
        'pent_maj': [0, 2, 4, 7, 9],
        'pent_min': [0, 3, 5, 7, 10],
        'blues': [0, 3, 5, 6, 7, 10],
        'maj_blues': [0, 2, 3, 4, 7, 9],

        // Bebop & 8-Note Scales (Perfect 4/4 Timing)
        'bebop_dom': [0, 2, 4, 5, 7, 9, 10, 11],    // Mixolydian + Major 7th passing tone
        'bebop_maj': [0, 2, 4, 5, 7, 8, 9, 11],     // Major + flat 6th passing tone
        'bebop_dorian': [0, 2, 3, 5, 7, 9, 10, 11], // Dorian + Major 7th passing tone

        // Exotic & World
        'phrygian_dom': [0, 1, 4, 5, 7, 8, 10],
        'double_harmonic': [0, 1, 4, 5, 7, 8, 11],  // Also known as Byzantine
        'hirajoshi': [0, 2, 3, 7, 8],
        'kumoi': [0, 2, 3, 7, 9],                   // Pentatonic
        'pelog': [0, 1, 3, 7, 8],                   // Pentatonic
        'insen': [0, 1, 5, 7, 10],
        'egyptian': [0, 2, 5, 7, 10],
        'persian': [0, 1, 4, 5, 6, 8, 11],

        // Jazz, Cinematic & Symmetrical
        'mixo_b6': [0, 2, 4, 5, 7, 8, 10],          // Aeolian Dominant (The "John Williams" scale)
        'acoustic': [0, 2, 4, 6, 7, 9, 10],         // Lydian Dominant
        'altered': [0, 1, 3, 4, 6, 8, 10],          // Super Locrian
        'lydian_aug': [0, 2, 4, 6, 8, 9, 11],       // 3rd mode of melodic minor
        'harmonic_maj': [0, 2, 4, 5, 7, 8, 11],
        'augmented': [0, 3, 4, 7, 8, 11],           // Symmetrical Hexatonic
        'wholetone': [0, 2, 4, 6, 8, 10],           // Symmetrical Hexatonic
        'diminished': [0, 1, 3, 4, 6, 7, 9, 10],    // Half-Whole Diminished
        'dim_wh': [0, 2, 3, 5, 6, 8, 9, 11],        // Whole-Half Diminished
        'prometheus': [0, 2, 4, 6, 9, 10],
        'enigmatic': [0, 1, 4, 6, 8, 10, 11],
        'tritone': [0, 1, 4, 6, 7, 10],             // Two major triads a tritone apart
        'enneatonic': [0, 2, 3, 4, 6, 7, 8, 10, 11] // 9-note symmetrical scale (Messiaen's Mode 3)
    };

    document.getElementById('keyCenter')?.addEventListener('change', e => { currentKeyCenter = parseInt(e.target.value); updateScaleOverlay(); updateLabels(); });
    document.getElementById('scaleOverlay')?.addEventListener('change', e => { currentScale = e.target.value; updateScaleOverlay(); });
    document.getElementById('labelType')?.addEventListener('change', e => { currentLabelType = e.target.value; updateLabels(); });

function updateScaleOverlay() {
        const mask = scaleMasks[currentScale];
        const activeScalePCs = new Set(mask.map(interval => (currentKeyCenter + interval) % 12));

        document.querySelectorAll('.highlightable').forEach(el => {
            if (!el._st) return;
            const inScale = el._st.every(st => activeScalePCs.has(((st % 12) + 12) % 12));
            if (currentScale === 'all' || inScale) el.classList.remove('dimmed-scale');
            else el.classList.add('dimmed-scale');
        });

        document.querySelectorAll('.label-text').forEach(el => {
            const pc = parseInt(el.getAttribute('data-pc'));
            if (currentScale === 'all' || activeScalePCs.has(pc)) el.classList.remove('dimmed-text');
            else el.classList.add('dimmed-text');
        });

        // --- RE-TRIGGER HEATMAP ON SCALE CHANGE ---
        if (typeof isHeatmapActive !== 'undefined' && isHeatmapActive) {
            updateHarmonicHeatmap();
        }

        // --- Dynamically hide/show the AI Scale Warning! ---
        const scaleWarning = document.getElementById('genScaleWarning');
        if (scaleWarning) {
            const isChromatic = !currentScale || currentScale === 'all';
            scaleWarning.style.display = isChromatic ? 'inline' : 'none';
        }

        // --- SYNC PIANO KEYBOARD HIGHLIGHTS ---
        if (typeof updatePianoScaleHighlights === 'function') {
            updatePianoScaleHighlights();
        }
    }

    function updateLabels() {
        document.querySelectorAll('.label-text').forEach(textEl => {
            const pc = parseInt(textEl.getAttribute('data-pc')); 
            const fifths = parseInt(textEl.getAttribute('data-fifths'));
            
            // Calculate the relative pitch class upfront for all relative modes
            const relativePc = (pc - currentKeyCenter + 12) % 12;

            // --- THE "MIXED" LOGIC ---
            if (currentLabelType === 'mixed') {
                // Use your existing CSS classes to identify if it's a chord triangle!
                if (textEl.classList.contains('text-triad') || textEl.classList.contains('text-cof-triad')) {
                    textEl.textContent = fifths >= 0 ? labelRomanSharp[relativePc] : labelRomanFlat[relativePc];
                } 
                // Otherwise, it's a single note node
                else {
                    textEl.textContent = fifths >= 0 ? labelDegreesSharp[relativePc] : labelDegreesFlat[relativePc];
                }
            } 
            // --- STANDARD LOGIC ---
            else if (currentLabelType === 'absolute') { 
                textEl.textContent = fifths >= 0 ? labelAbsoluteSharp[pc] : labelAbsoluteFlat[pc]; 
            }
            else if (currentLabelType === 'degrees') { 
                textEl.textContent = fifths >= 0 ? labelDegreesSharp[relativePc] : labelDegreesFlat[relativePc]; 
            }
            else if (currentLabelType === 'roman') { 
                textEl.textContent = fifths >= 0 ? labelRomanSharp[relativePc] : labelRomanFlat[relativePc]; 
            }
            else if (currentLabelType === 'solfege') {
                textEl.textContent = labelSolfege[relativePc];
            }
        });
    }

    // ==========================================
    // 6. GEOMETRY & RENDER: TONNETZ & COF
    // ==========================================
    const svgNS = "http://www.w3.org/2000/svg";

    function createPolygon(points, className) { const p = document.createElementNS(svgNS, "polygon"); p.setAttribute("points", points); p.setAttribute("class", className); return p; }
    function createLine(x1, y1, x2, y2, className) { const l = document.createElementNS(svgNS, "line"); l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2); l.setAttribute("class", className); return l; }
    function createCircle(x, y, r, className) { const c = document.createElementNS(svgNS, "circle"); c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", r); c.setAttribute("class", className); return c; }

    function createDynamicText(x, y, pc, fifths, sizeClass, isTriad = false, isPassing = false) {
        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", x); text.setAttribute("y", y); text.setAttribute("data-pc", pc); text.setAttribute("data-fifths", fifths);
        let baseClass = isTriad ? "text-triad" : (isPassing ? "text-passing" : "text-natural");
        text.setAttribute("class", `label-text ${baseClass} ${sizeClass}`);
        return text;
    }

    const tonnetzSvg = document.createElementNS(svgNS, "svg");

    // --- INJECT GRAVITY BORDER CSS ---
    const gravityStyle = document.createElement('style');
    gravityStyle.innerHTML = `
    /* Static, clean borders for gravity nodes. Completely transparent inside. */
    .gravity-border-local {
        fill: transparent !important;
        stroke: #00d2ff !important; /* Vivid Cyber Blue */
        stroke-width: 5px !important;
        stroke-linejoin: round !important;
        opacity: 1 !important;
        pointer-events: none !important;
    }
    
    .gravity-border-sequence {
        fill: transparent !important;
        stroke: #ff007f !important; /* Vivid Synthwave Pink */
        stroke-width: 6px !important;
        stroke-linejoin: round !important;
        opacity: 1 !important;
        pointer-events: none !important;
    }

    /* NEW: High-contrast outlines for the Chord Labels */
    .gravity-text-local {
        stroke: #00d2ff !important;
        stroke-width: 4px !important;
        paint-order: stroke fill !important; /* Draws the stroke behind the white text! */
    }

    .gravity-text-sequence {
        stroke: #ff007f !important;
        stroke-width: 5px !important;
        paint-order: stroke fill !important;
    }
    `;
    document.head.appendChild(gravityStyle);

    function resizeTonnetzSvg() {
        const wrapper = document.getElementById('tonnetz-wrapper');
        if (!wrapper) return;
        // Get exact current dimensions of the safe area wrapper
        const w = wrapper.clientWidth || window.innerWidth;
        const h = wrapper.clientHeight || window.innerHeight;

        tonnetzSvg.setAttribute("viewBox", `${-w / 2} ${-h / 2} ${w} ${h}`);
        updatePianoRange();
    }

    // PHASE 3: Use a ResizeObserver for perfectly smooth framing during CSS animations!
    const tonnetzObserver = new ResizeObserver(() => {
        requestAnimationFrame(resizeTonnetzSvg);
    });

    window.addEventListener('DOMContentLoaded', () => {
        const wrapper = document.getElementById('tonnetz-wrapper');
        if (wrapper) tonnetzObserver.observe(wrapper);
        resizeTonnetzSvg();
    });

    resizeTonnetzSvg();

    tonnetzSvg.appendChild(tonnetzZoomGroup);

    const gBackgrounds = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gBackgrounds);
    const gLines = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gLines);
    const gHighlightTriads = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gHighlightTriads);
    const gInterNodesSubtle = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gInterNodesSubtle);
    const gInterNodes = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gInterNodes);
    const gMainNodes = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gMainNodes);
    const gHighlightNodes = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gHighlightNodes);
    const gTriads = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gTriads);
    const gLabels = document.createElementNS(svgNS, "g"); tonnetzZoomGroup.appendChild(gLabels);

    function getXY(i, j) { return { x: i * DX + j * (DX / 2), y: j * DY }; }

    function setupSvgElement(el, stArray, isTriad, cloneLayer) {
        el.classList.add('highlightable');
        el._st = stArray;
        el._activeClass = isTriad ? 'triad-active' : 'node-active';

        let clone = el.cloneNode(true);
        clone.setAttribute('class', (el.getAttribute('class') || '').replace('highlightable', '') + ' highlight-overlay');
        clone.style.opacity = '0';
        cloneLayer.appendChild(clone);
        el._highlightEl = clone;

        el._startAction = () => { playFrequencies(el, stArray.map(getFreqFromSt), stArray); };
        el._stopAction = (f = false) => { stopFrequencies(el, f); };
    }

    const jMin = Math.floor((-GRID_H / 2) / DY) - gridBuffer;
    const jMax = Math.ceil((GRID_H / 2) / DY) + gridBuffer;

    for (let j = jMin; j <= jMax; j++) {
        const iMin = Math.floor((-GRID_W / 2 - j * (DX / 2)) / DX) - gridBuffer;
        const iMax = Math.ceil((GRID_W / 2 - j * (DX / 2)) / DX) + gridBuffer;

        for (let i = iMin; i <= iMax; i++) {
            const { x, y } = getXY(i, j); const fifths = i + j * 4; const pc = ((fifths * 7) % 12 + 12) % 12;
            const baseSemitones = i * 7 + j * 4 + 60;

            if (i < iMax && j < jMax) {
                const p1 = getXY(i, j), p2 = getXY(i + 1, j), p3 = getXY(i, j + 1);
                const poly = createPolygon(`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`, "triad-bg-major highlightable interactive-triad");
                gBackgrounds.appendChild(poly); setupSvgElement(poly, [baseSemitones, baseSemitones + 4, baseSemitones + 7], true, gHighlightTriads);
            }
            if (i < iMax && j > jMin) {
                const p1 = getXY(i, j), p2 = getXY(i + 1, j), p3 = getXY(i + 1, j - 1);
                const poly = createPolygon(`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`, "triad-bg-minor highlightable interactive-triad");
                gBackgrounds.appendChild(poly); setupSvgElement(poly, [baseSemitones, baseSemitones + 3, baseSemitones + 7], true, gHighlightTriads);
            }

            const mainCircle = createCircle(x, y, 22, "main-node highlightable interactive-node");
            gMainNodes.appendChild(mainCircle); setupSvgElement(mainCircle, [baseSemitones], false, gHighlightNodes);
            gLabels.appendChild(createDynamicText(x, y, pc, fifths, "font-lg"));

            if (i < iMax) gLines.appendChild(createLine(x, y, getXY(i + 1, j).x, getXY(i + 1, j).y, "line-grid"));
            if (j < jMax) {
                const p2 = getXY(i, j + 1); gLines.appendChild(createLine(x, y, p2.x, p2.y, "line-grid"));
                [0.25, 0.5, 0.75].forEach((frac, k) => {
                    const mx = x + (p2.x - x) * frac; const my = y + (p2.y - y) * frac; const offsetF = [-5, 2, -3][k]; const midPc = (((fifths + offsetF) * 7) % 12 + 12) % 12;
                    if (k === 1) {
                        const descNode = createCircle(mx, my, 20, "inter-node-desc highlightable interactive-node"); gInterNodes.appendChild(descNode);
                        setupSvgElement(descNode, [baseSemitones + 2], false, gHighlightNodes); gLabels.appendChild(createDynamicText(mx, my, midPc, fifths + offsetF, "font-md"));
                    } else {
                        const passingNode = createCircle(mx, my, 12, "inter-node-desc-subtle highlightable interactive-node"); gInterNodesSubtle.appendChild(passingNode);
                        setupSvgElement(passingNode, [baseSemitones + k + 1], false, gHighlightNodes); gLabels.appendChild(createDynamicText(mx, my, midPc, fifths + offsetF, "font-xs", false, true));
                    }
                });
            }
            if (i < iMax && j > jMin) {
                const p2 = getXY(i + 1, j - 1); gLines.appendChild(createLine(x, y, p2.x, p2.y, "line-grid"));
                [1 / 3, 2 / 3].forEach((frac, k) => {
                    const mx = x + (p2.x - x) * frac; const my = y + (p2.y - y) * frac; const offsetF = [-5, 2][k]; const midPc = (((fifths + offsetF) * 7) % 12 + 12) % 12;
                    const ascNode = createCircle(mx, my, 18, "inter-node-asc highlightable interactive-node"); gInterNodes.appendChild(ascNode);
                    setupSvgElement(ascNode, [baseSemitones + k + 1], false, gHighlightNodes); gLabels.appendChild(createDynamicText(mx, my, midPc, fifths + offsetF, "font-sm"));
                });
            }
            if (i < iMax && j < jMax) { const tText = createDynamicText(x + DX / 2, y + DY / 3, pc, fifths, "font-lg", true); gTriads.appendChild(tText); }
            if (i < iMax && j > jMin) { const tText = createDynamicText(x + DX / 2, y - DY / 3, pc, fifths, "font-lg", true); tText.classList.add('minor-triad-label'); gTriads.appendChild(tText); }
        }
    }
    const svgContainer = document.getElementById("svg-container");
    if (svgContainer) svgContainer.appendChild(tonnetzSvg);

    const cofSvg = document.createElementNS(svgNS, "svg"); cofSvg.setAttribute("viewBox", "-400 -400 800 800");
    const cofLines = document.createElementNS(svgNS, "g"); cofSvg.appendChild(cofLines);
    const cofNodes = document.createElementNS(svgNS, "g"); cofSvg.appendChild(cofNodes);
    const cofHighlightNodes = document.createElementNS(svgNS, "g"); cofSvg.appendChild(cofHighlightNodes);
    const cofLabels = document.createElementNS(svgNS, "g"); cofSvg.appendChild(cofLabels);

    [{ r: 340, fill: "#e1f5fe" }, { r: 260, fill: "var(--bg-color)" }, { r: 180, fill: "#fce4ec" }, { r: 100, fill: "var(--bg-color)" }].forEach(d => { const bg = createCircle(0, 0, d.r, ""); bg.setAttribute("fill", d.fill); bg.style.transition = "fill 0.3s"; cofLines.appendChild(bg); });

    [100, 180, 260, 340].forEach(r => { const ring = createCircle(0, 0, r, "line-grid"); ring.setAttribute("fill", "none"); cofLines.appendChild(ring); });

    ["Circle", "of", "Fifths"].forEach((text, i) => {
        const txt = document.createElementNS(svgNS, "text");
        txt.setAttribute("x", "0");
        txt.setAttribute("y", [-36, 0, 36][i]);
        txt.setAttribute("class", "text-cof-center");
        txt.textContent = text;
        cofLabels.appendChild(txt);
    });

    for (let i = 0; i < 12; i++) {
        const rad = (i * 30 - 90) * Math.PI / 180; const radRot = (i * 30 - 90 + 15) * Math.PI / 180;
        cofLines.appendChild(createLine(100 * Math.cos(rad), 100 * Math.sin(rad), 180 * Math.cos(rad), 180 * Math.sin(rad), "line-grid")); cofLines.appendChild(createLine(180 * Math.cos(radRot), 180 * Math.sin(radRot), 260 * Math.cos(radRot), 260 * Math.sin(radRot), "line-grid")); cofLines.appendChild(createLine(260 * Math.cos(rad), 260 * Math.sin(rad), 340 * Math.cos(rad), 340 * Math.sin(rad), "line-grid"));
        const fifths = i <= 6 ? i : i - 12; const sigRad = (i * 30 - 90 - 12) * Math.PI / 180;
        const txt = document.createElementNS(svgNS, "text"); txt.setAttribute("x", 220 * Math.cos(sigRad)); txt.setAttribute("y", 220 * Math.sin(sigRad)); txt.setAttribute("class", "text-keysig"); txt.textContent = fifths > 0 ? fifths + "♯" : (fifths < 0 ? Math.abs(fifths) + "♭" : "♮"); cofLabels.appendChild(txt);

        const placeCofNode = (r, fOffset, className, size, isRot) => {
            const uRad = isRot ? radRot : rad; const pc = (((fifths + fOffset) * 7) % 12 + 12) % 12;
            const circle = createCircle(r * Math.cos(uRad), r * Math.sin(uRad), size, `${className} highlightable interactive-node`); cofNodes.appendChild(circle);
            let notes = [pc + 60];
            setupSvgElement(circle, notes, false, cofHighlightNodes);
            cofLabels.appendChild(createDynamicText(r * Math.cos(uRad), r * Math.sin(uRad), pc, fifths + fOffset, size > 25 ? "font-lg" : "font-md"));
        };
        placeCofNode(140, -3, "cof-inter-node-min3", 20, true); placeCofNode(220, 0, "main-node", 32, false); placeCofNode(300, 4, "cof-inter-node-maj3", 20, true);

        const rootPc = ((fifths * 7) % 12 + 12) % 12;
        const minCircle = createCircle(180 * Math.cos(radRot), 180 * Math.sin(radRot), 14, "cof-minor-node highlightable interactive-node"); cofNodes.appendChild(minCircle);
        setupSvgElement(minCircle, [rootPc + 60, rootPc + 3 + 60, rootPc + 7 + 60], true, cofHighlightNodes);
        const minT = createDynamicText(180 * Math.cos(radRot), 180 * Math.sin(radRot), rootPc, fifths, "text-cof-triad", true); minT.classList.add('minor-triad-label'); cofLabels.appendChild(minT);

        const majCircle = createCircle(260 * Math.cos(radRot), 260 * Math.sin(radRot), 14, "cof-major-node highlightable interactive-node"); cofNodes.appendChild(majCircle);
        setupSvgElement(majCircle, [rootPc + 60, rootPc + 4 + 60, rootPc + 7 + 60], true, cofHighlightNodes);
        cofLabels.appendChild(createDynamicText(260 * Math.cos(radRot), 260 * Math.sin(radRot), rootPc, fifths, "text-cof-triad", true));
    }
    const cofContainer = document.getElementById("cof-container");
    if (cofContainer) cofContainer.appendChild(cofSvg);

    const originalUpdateLabels = updateLabels;
    updateLabels = function () { originalUpdateLabels(); document.querySelectorAll('.minor-triad-label').forEach(el => el.textContent += "⁻"); }

    document.documentElement.style.setProperty('--piano-h', isPianoActive ? 'clamp(80px, 16vh, 140px)' : '0px');

    // --- TIERED UI SYNC ---
    // Sync the Polyphony UI slider to whatever the Profiler decided it should be
    const maxVoicesUI = document.getElementById('maxVoices');
    const lblMaxVoices = document.getElementById('lblMaxVoices');
    if (maxVoicesUI && lblMaxVoices) {
        maxVoicesUI.value = maxVoices;
        lblMaxVoices.textContent = `Polyphony: ${maxVoices}`;
    }

    // On Low-End devices, explicitly kill the JS math for the background pulse
    if (perfProfile.tier === 'low') {
        console.log("Applying Low-Tier CPU Optimizations...");

        const bgMode = document.getElementById('bgEffectMode');
        if (bgMode) {
            bgMode.value = 'off';
            bgMode.dispatchEvent(new Event('change'));
        }

        const bgIntensityUI = document.getElementById('bgIntensity');
        const lblBgIntensity = document.getElementById('lblBgIntensity');
        if (bgIntensityUI && lblBgIntensity) {
            bgIntensityUI.value = 0;
            lblBgIntensity.textContent = `BG Intensity: 0%`;
        }
    }

    window.syncAllTrackRouting = function() {
        if (typeof audioCtx === 'undefined' || !audioCtx || typeof synthGain === 'undefined' || typeof drumGain === 'undefined') return;

        // 1. Re-patch Looper Tracks (0-7)
        if (typeof looperPanners !== 'undefined') {
            for (let i = 0; i < looperPanners.length; i++) {
                if (looperPanners[i] && typeof studio !== 'undefined' && studio.trackTypes[i] !== null) {
                    try {
                        looperPanners[i].disconnect();
                        looperPanners[i].connect(studio.trackTypes[i] === 'drum' ? drumGain : synthGain);
                    } catch (e) { console.warn("Failed to route Looper track", i); }
                }
            }
        }

        // 2. Re-patch Arranger Tracks (8-15+)
        if (typeof linearPanners !== 'undefined') {
            for (let i = 0; i < linearPanners.length; i++) {
                if (linearPanners[i] && typeof studio !== 'undefined' && studio.trackTypes[i + 8] !== null) {
                    try {
                        linearPanners[i].disconnect();
                        linearPanners[i].connect(studio.trackTypes[i + 8] === 'drum' ? drumGain : synthGain);
                    } catch (e) { console.warn("Failed to route Arranger track", i + 8); }
                }
            }
        }
    };

    // =========================================================================
    // MULTI-FORMAT STEM, MIDI & DAWPROJECT IMPORTER (The Ultimate Version)
    // =========================================================================
    document.getElementById('btn-import-stems')?.addEventListener('click', () => {
        if (typeof JSZip === 'undefined') { showToast("JSZip library is loading..."); return; }
        document.getElementById('import-zip-input').click();
    });

    // --- AUDIO STEM PEAK CACHER ---
    function extractAudioPeaks(audioBuffer) {
        // Dynamic resolution based on Hardware Tier
        let numBuckets = 250; 
        if (perfProfile.tier === 'mid') numBuckets = 750;
        if (perfProfile.tier === 'high') numBuckets = 2000;

        if (!audioBuffer) return new Float32Array(numBuckets);
        
        const rawData = audioBuffer.getChannelData(0); // Just use left channel for UI
        const peaks = new Float32Array(numBuckets);
        const blockSize = Math.floor(rawData.length / numBuckets);

        for (let i = 0; i < numBuckets; i++) {
            let max = 0;
            const start = i * blockSize;
            // Skipping by 10 optimizes the loop without losing visual transients
            for (let j = 0; j < blockSize; j += 10) {
                const abs = Math.abs(rawData[start + j]);
                if (abs > max) max = abs;
            }
            peaks[i] = max;
        }
        return peaks;
    }

    document.getElementById('import-zip-input')?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        // 1. Sledgehammer Empty Check (Physically count events on the timeline)
        let totalEvents = 0;
        looper.tracks.forEach(t => totalEvents += t.length);
        arranger.tracks.forEach(t => totalEvents += t.length);
        const hasAudioData = studio.trackAudioBuffers.some(b => b !== null);

        const isProjectEmpty = (totalEvents === 0 && !hasAudioData);
        let mode = 'add'; // Default to Add so we never ruin the user's UI selection!

        if (!isProjectEmpty) {
            if (confirm("⚠️ Active project detected!\n\nClick [OK] to REPLACE current tracks (unsaved data lost).\nClick [Cancel] to ADD to tracks.")) {
                mode = 'replace';
            }
        }

        showToast(`Processing ${files.length} file(s)... Please wait.`);
        initAudio();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        // 2. Clear project if user explicitly chose 'Replace'
        if (mode === 'replace') {
            looper.tracks.forEach((t, i) => { looper.tracks[i] = []; looper.trackDurations[i] = 0; looper.lastPhases[i] = 0; looper.regions[i] = []; });
            arranger.tracks.forEach((t, i) => arranger.tracks[i] = []);
            arranger.duration = 0;
            arranger.pauseTime = 0;
            studio.trackAudioBuffers.fill(null);
            studio.trackTypes.fill(null);
            document.querySelectorAll('.track-btn').forEach(btn => {
                btn.classList.remove('type-voice', 'type-drum', 'active');
                btn.style.borderBottom = ''; 
            });
    
            // Force the sequencer back to A1 ONLY if we are starting a completely fresh project
            studio.activeArrangerTrack = 8;
            studio.activeLooperTrack = 0;
            studio.lastSelectedDomain = 'arranger';
            document.querySelector('.track-btn[data-track="8"]')?.classList.add('active');
        }

        // --- HARDCORE TEMPO UPDATER ---
        const applyImportedBPM = (newBpm) => {
            const bpm = Math.round(newBpm);
            if (!isNaN(bpm) && bpm >= 40 && bpm <= 240) {
                currentArpBPM = bpm;
                if (typeof anchorBPM !== 'undefined') anchorBPM = bpm; // Fixes Time-Stretch!
        
                const mainBpmSlider = document.getElementById('arpBpm');
                const drumBpmSlider = document.getElementById('drumBpmSlider');
                const mainBpmLbl = document.getElementById('lblArpBpm');
                const drumBpmLbl = document.getElementById('drumBpmValue');
                const globalBpmDisp = document.getElementById('global-bpm-display');
        
                if (mainBpmSlider) mainBpmSlider.value = bpm;
                if (drumBpmSlider) drumBpmSlider.value = bpm;
                if (mainBpmLbl) mainBpmLbl.textContent = `Arp/Metron: ${bpm} BPM`;
                if (drumBpmLbl) drumBpmLbl.textContent = bpm;
                if (globalBpmDisp) globalBpmDisp.textContent = `${bpm} BPM`;

                if (currentLfoSync === 'sync' && typeof updateLfoSpeed === 'function') updateLfoSpeed();
                console.log(`Successfully adopted imported tempo: ${bpm} BPM`);
            }
        };

        // --- UPGRADED HELPER: Strict Domain Empty Track Hunter ---
        const getNextFreeTrack = (preferLooper = false, startIdxOverride = -1, strictDomain = false) => {
            const activeDomain = studio.lastSelectedDomain;
            let startIdx = startIdxOverride !== -1 ? startIdxOverride : (activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack);
            const arrangerMax = 8 + (typeof currentArrangerTrackCount !== 'undefined' ? currentArrangerTrackCount : 8);

            const isTrackEmpty = (i) => {
                const domainObj = i < 8 ? looper : arranger;
                const localIdx = i < 8 ? i : i - 8;
                if (!domainObj.tracks[localIdx]) return false; // Failsafe
                return domainObj.tracks[localIdx].length === 0 && studio.trackAudioBuffers[i] === null;
            };

            // 1. Try starting from the currently selected track downwards
            const primaryEnd = preferLooper ? 8 : arrangerMax;
            for (let i = startIdx; i < primaryEnd; i++) {
                if (isTrackEmpty(i)) return i;
            }
    
            // 2. Wrap around and check from the beginning of that domain
            const primaryStart = preferLooper ? 0 : 8;
            for (let i = primaryStart; i < startIdx; i++) {
                if (isTrackEmpty(i)) return i;
            }

            // 3. If standard search fails, check the OTHER domain as a last resort
            if (!strictDomain) {
                const overflowStart = preferLooper ? 8 : 0;
                const overflowEnd = preferLooper ? arrangerMax : 8;
                for (let i = overflowStart; i < overflowEnd; i++) {
                    if (isTrackEmpty(i)) return i;
                }
            }
            return -1; 
        };

        // --- DEEP CLONE HELPER (Fixes the shared reference bug!) ---
        const getFreshSynthState = () => {
            const base = typeof captureCurrentSynthState === 'function' ? captureCurrentSynthState() : {};
            return JSON.parse(JSON.stringify(base));
        };

        // --- PREFIX CLEANER HELPER (Added to keep UI clean) ---
        const cleanLabelName = (name) => {
            if (!name) return "";
            return name.replace(/^sample_db:/i, '')
                .replace(/^sample_folder:/i, '')
                .replace(/\.wav$/i, '')
                .replace(/\.mid$/i, '')
                .replace(/\.midi$/i, '')
                .substring(0, 12)
                .toUpperCase();
        };

        // 3. Process all selected files
        for (const file of files) {
            const ext = file.name.split('.').pop().toLowerCase();

            // ==============================================================
            // A. ZIP / DAWPROJECT EXTRACTION
            // ==============================================================
            if (ext === 'zip' || ext === 'dawproject') {
                try {
                    console.log("DEBUG [1]: ZIP/DAWPROJECT detected. Initializing JSZip...");
                    const zip = await JSZip.loadAsync(file);
            
                    const sessionFile = zip.file("tonnetz_session.json");
                    const fileKeys = Object.keys(zip.files).filter(k => !zip.files[k].dir);
            
                    console.log("DEBUG [2]: ZIP loaded. Session file exists:", !!sessionFile);

                    let trackMetadata = {}; 
                    let isNativeProject = false;
                    let stretchRatio = 1.0;

                    // --- 1. SESSION RESTORATION (THE BRAIN) ---
                    if (sessionFile) {
                        console.log("DEBUG [3]: Native Session found. Restoring studio state...");
                        isNativeProject = true;
                        const sessionText = await sessionFile.async("string");
                        const state = JSON.parse(sessionText);

                        applyImportedBPM(state.bpm);

                        // Expand track banks if necessary
                        if (state.currentArrangerTrackCount && state.currentArrangerTrackCount > 8) {
                            const banksNeeded = (state.currentArrangerTrackCount - 8) / 8;
                            const addBankBtn = document.getElementById('btnAddArrangerBank');
                            if (addBankBtn) for (let b = 0; b < banksNeeded; b++) addBankBtn.click();
                        }

                        // Physical restoration of MIDI notes, Synth Brains, and types
                        Object.assign(looper, state.looperState);
                        Object.assign(arranger, state.arrangerState);
                        Object.assign(studio, state.studioState);
                        arranger.duration = state.exportDuration || arranger.duration;
                        console.log("DEBUG [4]: Native Engine State restored.");
                    } 
            
                    // Always parse XML for metadata (helps with foreign projects and track colors)
                    const xmlFile = zip.file("project.xml");
                    if (xmlFile) {
                        try {
                            const xmlText = await xmlFile.async("string");
                            const parser = new DOMParser();
                            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                            const transportNode = xmlDoc.querySelector("transport");
                            if (transportNode && transportNode.getAttribute("tempo")) {
                                const importedBpm = parseFloat(transportNode.getAttribute("tempo"));
                                if (!isNativeProject) {
                                    if (mode === 'replace' || isProjectEmpty) applyImportedBPM(importedBpm);
                                    else {
                                        const bpmDiff = Math.abs(currentArpBPM - importedBpm) / importedBpm;
                                        if (bpmDiff <= MAX_BPM_STRETCH_RATIO) {
                                            stretchRatio = currentArpBPM / importedBpm;
                                        }
                                    }
                                }
                            }
                            xmlDoc.querySelectorAll("track").forEach(track => {
                                const audioFileNode = track.querySelector("audio-file");
                                let path = audioFileNode ? audioFileNode.getAttribute("path") : null;
                                if (path) {
                                    if (path.startsWith("./")) path = path.substring(2);
                                    trackMetadata[path] = { 
                                        name: track.getAttribute("name"), 
                                        volume: 1.0, pan: 0.0 
                                    };
                                }
                            });
                            console.log("DEBUG [5]: Metadata parsed.");
                        } catch (e) { console.error("XML Error", e); }
                    }

                    // --- 2. ASSET PASS (SAMPLER RAM & TIMELINE LINKING) ---
                    console.log("DEBUG [7]: Starting Asset Pass...");
                    for (const filename of fileKeys) {
                        const fileData = await zip.files[filename].async("arraybuffer");

                        // A. RESTORE SAMPLER RAM (RAW ASSETS)
                        // FIXED: Removed the `.endsWith('.wav')` restriction so .flac, .mp3, etc. load into RAM!
                        if (filename.startsWith("Raw_Assets/")) {
                            const audioBuffer = await audioCtx.decodeAudioData(fileData);
                            const cleanName = filename.split('/').pop();
                            if (typeof sampleBank !== 'undefined') {
                                registerSample(`sample_db:${cleanName}`, audioBuffer);
                                registerSample(`sample_folder:${cleanName}`, audioBuffer);
                            }
                    
                            if (isNativeProject) {
                                const link = (domain, offset) => {
                                    domain.tracks.forEach((track, lIdx) => {
                                        track.forEach(evt => {
                                            if (evt.type === 'stem' && evt.name === cleanName) {
                                                evt.buffer = audioBuffer;
                                                studio.trackAudioBuffers[lIdx + offset] = audioBuffer;
                                            }
                                        });
                                    });
                                };
                                link(looper, 0); link(arranger, 8);
                            }
                            continue;
                        }

                        // B. FOREIGN MIDI IMPORT (Only if not a Native Project)
                        if ((filename.endsWith('.mid') || filename.endsWith('.midi')) && !isNativeProject) {
                            console.log("DEBUG [8]: Importing Foreign MIDI:", filename);
                            let isLooperPrefer = filename.includes('_L');
                            let targetIdx = getNextFreeTrack(isLooperPrefer, -1, true);
                            if (targetIdx === -1) continue;

                            try {
                                const parsedMidi = new Midi(fileData);
                                const isL = targetIdx < 8;
                                const localIdx = isL ? targetIdx : targetIdx - 8;
                                const domainObj = isL ? looper : arranger;
                                if (!studio.trackSynthStates[targetIdx]) studio.trackSynthStates[targetIdx] = getFreshSynthState();

                                parsedMidi.tracks.forEach(track => {
                                    track.notes.forEach(note => {
                                        domainObj.tracks[localIdx].push({
                                            id: Math.random(), type: 'play', timeOffset: note.time * (1 / stretchRatio),
                                            duration: note.duration * (1 / stretchRatio), freqs: [masterTune * Math.pow(2, (note.midi - 69) / 12)], 
                                            velocity: Math.round(note.velocity * 127),
                                            synthState: studio.trackSynthStates[targetIdx]
                                        });
                                    });
                                });
                                studio.trackTypes[targetIdx] = 'voice';
                                const labelEl = document.getElementById(`inst-label-${targetIdx}`);
                                if (labelEl) labelEl.textContent = cleanLabelName(filename.split('/').pop());
                            } catch (e) { console.error("MIDI Parse Error", e); }
                        }
                    }

                    // --- 3. STEM PASS (FOREIGN BACKUP ONLY) ---
                    console.log("DEBUG [9]: Starting Stem Pass...");
                    for (const filename of fileKeys) {
                        if (filename.endsWith('.wav') && filename.startsWith("Audio/")) {
                            if (isNativeProject) {
                                console.log("DEBUG [10]: Native Project - Skipping redundant Audio Stem:", filename);
                                continue; 
                            }

                            console.log("DEBUG [11]: Importing Foreign Audio Stem:", filename);
                            const fileData = await zip.files[filename].async("arraybuffer");
                            const audioBuffer = await audioCtx.decodeAudioData(fileData);
                    
                            let isLooperPrefer = filename.includes('_L');
                            let targetIdx = getNextFreeTrack(isLooperPrefer, -1, true);
                            if (targetIdx === -1) continue;

                            const isL = targetIdx < 8;
                            const domainObj = isL ? looper : arranger;
                            const localIdx = isL ? targetIdx : targetIdx - 8;

                            domainObj.tracks[localIdx].push({
                                id: Math.random(), type: 'stem', timeOffset: 0,
                                duration: audioBuffer.duration * (1 / stretchRatio), buffer: audioBuffer,
                                stretchRatio: stretchRatio, peaks: extractAudioPeaks(audioBuffer), name: filename.split('/').pop()
                            });
                            studio.trackAudioBuffers[targetIdx] = audioBuffer;
                            studio.trackTypes[targetIdx] = 'voice';
                            const labelEl = document.getElementById(`inst-label-${targetIdx}`);
                            if (labelEl) labelEl.textContent = cleanLabelName(filename.split('/').pop());
                        }
                    }

                    // --- 4. HARDWARE SYNC & UI REFRESH (NATIVE ONLY) ---
                    if (isNativeProject) {
                        console.log("DEBUG [12]: Applying Mixer & UI settings...");
                        const sessionText = await sessionFile.async("string");
                        const state = JSON.parse(sessionText);
                        const totalTracksCount = 8 + (state.currentArrangerTrackCount || 8);

                        for (let i = 0; i < totalTracksCount; i++) {
                            const type = studio.trackTypes[i];
                            const btn = document.querySelector(`.track-btn[data-track="${i}"]`);
                            const labelEl = document.getElementById(`inst-label-${i}`);
                            const muteBtn = document.querySelector(`.mute-btn[data-track="${i}"]`);

                            if (type !== null) {
                                if (btn) {
                                    btn.classList.remove('type-voice', 'type-drum');
                                    btn.classList.add(type === 'drum' ? 'type-drum' : 'type-voice');
                                }
                        
                                if (labelEl && studio.trackSynthStates[i]) {
                                    labelEl.textContent = type === 'drum' ? 'DRUMS' : cleanLabelName(studio.trackSynthStates[i].instrumentPreset || 'SYNTH');
                                }

                                if (muteBtn) {
                                    const isM = (i < 8) ? looper.muted[i] : arranger.muted[i - 8];
                                    muteBtn.classList.toggle('muted', !!isM);
                                }

                                // Apply to Hardware Audio Nodes
                                if (state.mixerState) {
                                    const hwG = (i < 8) ? looperGainNodes[i] : linearGainNodes[i - 8];
                                    const hwP = (i < 8) ? looperPanners[i] : linearPanners[i - 8];
                                    const hwE = (i < 8) ? looperEchoSends[i] : linearEchoSends[i - 8];
                                    const hwR = (i < 8) ? looperReverbSends[i] : linearReverbSends[i - 8];

                                    if (hwG && state.mixerState.volumes) hwG.gain.setTargetAtTime(state.mixerState.volumes[i], audioCtx.currentTime, 0.015);
                                    if (hwP && state.mixerState.pans) hwP.pan.setTargetAtTime(state.mixerState.pans[i], audioCtx.currentTime, 0.015);
                                    if (hwE && state.mixerState.echoSends) hwE.gain.setTargetAtTime(state.mixerState.echoSends[i], audioCtx.currentTime, 0.015);
                                    if (hwR && state.mixerState.reverbSends) hwR.gain.setTargetAtTime(state.mixerState.reverbSends[i], audioCtx.currentTime, 0.015);
                            
                                    const vVol = document.querySelector(`.track-vol[data-track="${i}"]`);
                                    const vPan = document.querySelector(`.pan-slider[data-track="${i}"]`);
                                    const vEcho = document.querySelector(`.echo-send[data-track="${i}"]`);
                                    const vReverb = document.querySelector(`.reverb-send[data-track="${i}"]`);

                                    if (vVol && state.mixerState.volumes) vVol.value = state.mixerState.volumes[i];
                                    if (vPan && state.mixerState.pans) vPan.value = state.mixerState.pans[i];
                                    if (vEcho && state.mixerState.echoSends) vEcho.value = state.mixerState.echoSends[i];
                                    if (vReverb && state.mixerState.reverbSends) vReverb.value = state.mixerState.reverbSends[i];
                                }
                            } else {
                                if (labelEl) {
                                    const prefix = i < 8 ? 'L' : 'A';
                                    const num = i < 8 ? i + 1 : i - 7;
                                    labelEl.textContent = `${prefix}${num}`;
                                }
                                if (btn) btn.classList.remove('type-voice', 'type-drum');
                            }
                        }
                        applySynthStateToUI(studio.trackSynthStates[studio.activeLooperTrack]);

                        // NEW: MASTER FX & GLOBAL STATE RESTORATION
                        if (state.masterState) {
                            const applyGlobal = (id, val) => {
                                const el = document.getElementById(id);
                                if (el && val !== undefined) {
                                    el.value = val;
                                    el.dispatchEvent(new Event('input')); // Triggers physical routing
                                    el.dispatchEvent(new Event('change')); // Updates the UI label text
                                }
                            };

                            // THE FIX: Uses actual DOM IDs from your HTML
                            applyGlobal('masterVol', state.masterState.masterVolume);
                            applyGlobal('eqLow', state.masterState.eqLow);
                            applyGlobal('eqMid', state.masterState.eqMid);
                            applyGlobal('eqHigh', state.masterState.eqHigh);
                            applyGlobal('declick', state.masterState.declickDelay);
                            applyGlobal('busComp', state.masterState.busComp);
                            applyGlobal('limiterMode', state.masterState.limiter);
                        }
                    }

                    console.log("DEBUG [13]: Project Restoration Complete.");
                } catch (e) {
                    console.error("DEBUG [FATAL]:", e);
                    showToast("Error unpacking .dawproject archive.");
                }
            }

            // ==============================================================
            // B. INDIVIDUAL AUDIO FILES (.WAV / .MP3 / .FLAC)
            // ==============================================================
            else if (ext === 'wav' || ext === 'mp3' || ext === 'flac') {
                const activeDomain = studio.lastSelectedDomain;
                const targetTrackIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
                const isLooperDomain = targetTrackIdx < 8;
                const localIdx = isLooperDomain ? targetTrackIdx : targetTrackIdx - 8;
                const domainObj = isLooperDomain ? looper : arranger;

                const arrayBuffer = await file.arrayBuffer();
                const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                const visualPeaks = extractAudioPeaks(audioBuffer); 
    
                let stretchRatio = 1.0;
                const bpmMatch = file.name.match(/(\d{2,3})\s*bpm/i); 
    
                if (bpmMatch) {
                    const importedBpm = parseFloat(bpmMatch[1]);
                    if (mode === 'replace' || isProjectEmpty) {
                        applyImportedBPM(importedBpm);
                    } else {
                        const bpmDiff = Math.abs(currentArpBPM - importedBpm) / importedBpm;
                        if (bpmDiff <= MAX_BPM_STRETCH_RATIO) {
                            stretchRatio = currentArpBPM / importedBpm;
                            showToast(`Time-Stretching audio by ${Math.round(stretchRatio * 100)}% to match DAW tempo.`);
                        } else {
                            showToast("BPM difference > 15%. Audio imported without time-stretching.", "warning");
                        }
                    }
                }

                const playheadOffset = isLooperDomain ? 0 : (arranger.pauseTime || 0);
                let finalDuration = audioBuffer.duration;
                if (isLooperDomain) {
                    const loopMaxSecs = (60 / currentArpBPM) * 16; 
                    finalDuration = Math.min(audioBuffer.duration, loopMaxSecs);
                }

                const adjustedDuration = finalDuration * (1 / stretchRatio);
                domainObj.tracks[localIdx].push({ 
                    id: Math.random(), type: 'stem', timeOffset: playheadOffset, 
                    duration: adjustedDuration, buffer: audioBuffer, stretchRatio: stretchRatio,
                    peaks: visualPeaks, name: file.name 
                });
    
                if (!studio.trackAudioBuffers[targetTrackIdx]) studio.trackAudioBuffers[targetTrackIdx] = audioBuffer;
                if (!isLooperDomain && (playheadOffset + adjustedDuration > arranger.duration)) {
                    arranger.duration = playheadOffset + adjustedDuration;
                }
                studio.trackTypes[targetTrackIdx] = 'voice';

                const labelEl = document.getElementById(`inst-label-${targetTrackIdx}`);
                if (labelEl) labelEl.textContent = cleanLabelName(file.name);
                const btn = document.querySelector(`.track-btn[data-track="${targetTrackIdx}"]`);
                if (btn) btn.classList.add('type-voice');
            }

            // ==============================================================
            // C. INDIVIDUAL MULTI-TRACK MIDI FILES (.MID / .MIDI)
            // ==============================================================
            else if (ext === 'mid' || ext === 'midi') {
                if (typeof Midi === 'undefined') {
                    showToast("MIDI parser not loaded! Please check your internet connection.");
                    continue;
                }

                const activeDomain = studio.lastSelectedDomain;
                const targetDomainIsLooper = activeDomain === 'looper';

                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const parsedMidi = new Midi(arrayBuffer);
                    const activeMidiTracks = parsedMidi.tracks.filter(t => t.notes.length > 0);
                    if (activeMidiTracks.length === 0) {
                        showToast("MIDI file contains no note data.");
                        continue;
                    }

                    let stretchRatio = 1.0;
                    if (parsedMidi.header && parsedMidi.header.tempos && parsedMidi.header.tempos.length > 0) {
                        const importedBpm = parsedMidi.header.tempos[0].bpm;
                        if (mode === 'replace' || isProjectEmpty) {
                            applyImportedBPM(importedBpm);
                        } else {
                            const bpmDiff = Math.abs(currentArpBPM - importedBpm) / importedBpm;
                            if (bpmDiff <= MAX_BPM_STRETCH_RATIO) {
                                stretchRatio = currentArpBPM / importedBpm;
                                showToast(`Time-Stretching MIDI events by ${Math.round(stretchRatio * 100)}% to match DAW tempo.`);
                            } else {
                                showToast("BPM difference > 15%. MIDI imported without time-stretching.", "warning");
                            }
                        }
                    }

                    const playheadOffset = targetDomainIsLooper ? 0 : (arranger.pauseTime || 0);
                    let currentSearchIdx = targetDomainIsLooper ? studio.activeLooperTrack : studio.activeArrangerTrack;

                    for (let i = 0; i < activeMidiTracks.length; i++) {
                        const midiTrack = activeMidiTracks[i];
                        let targetTrackIdx = getNextFreeTrack(targetDomainIsLooper, currentSearchIdx, true);

                        if (targetTrackIdx === -1 && !targetDomainIsLooper) {
                            const addBankBtn = document.getElementById('btnAddArrangerBank');
                            if (addBankBtn) {
                                addBankBtn.click(); 
                                targetTrackIdx = getNextFreeTrack(false, currentSearchIdx, true); 
                            }
                        }

                        if (targetTrackIdx === -1) {
                            showToast(`Ran out of tracks! Track ${i + 1} skipped.`);
                            break; 
                        }

                        const isTargetLooper = targetTrackIdx < 8;
                        const localIdx = isTargetLooper ? targetTrackIdx : targetTrackIdx - 8;
                        const domainObj = isTargetLooper ? looper : arranger;
                        const isDrumTrack = (midiTrack.channel === 9);

                        if (!studio.trackSynthStates[targetTrackIdx]) {
                            studio.trackSynthStates[targetTrackIdx] = getFreshSynthState();
                        } else {
                            studio.trackSynthStates[targetTrackIdx] = JSON.parse(JSON.stringify(studio.trackSynthStates[targetTrackIdx]));
                        }

                        let finalTrackName = midiTrack.name.trim() || (midiTrack.instrument ? midiTrack.instrument.name : "");
                        if (!finalTrackName) {
                            const cleanFileName = file.name.replace(/\.[^/.]+$/, "");
                            finalTrackName = activeMidiTracks.length > 1 ? `${cleanFileName} - T${i + 1}` : cleanFileName;
                        }

                        studio.trackTypes[targetTrackIdx] = isDrumTrack ? 'drum' : 'voice';
                        const btn = document.querySelector(`.track-btn[data-track="${targetTrackIdx}"]`);
                        if (btn) {
                            btn.classList.remove('type-voice', 'type-drum');
                            btn.classList.add(isDrumTrack ? 'type-drum' : 'type-voice');
                        }

                        const labelEl = document.getElementById(`inst-label-${targetTrackIdx}`);
                        if (labelEl) labelEl.textContent = cleanLabelName(finalTrackName);

                        let trackMaxDur = 0;
                        midiTrack.notes.forEach(note => {
                            const adjustedTime = (note.time * (1 / stretchRatio)) + playheadOffset;
                            const adjustedDur = note.duration * (1 / stretchRatio);
                
                            if (isDrumTrack) {
                                let alias = 'click'; 
                                if (typeof gmDrumMap !== 'undefined' && gmDrumMap[note.midi]) alias = gmDrumMap[note.midi].alias;
                                domainObj.tracks[localIdx].push({
                                    id: Math.random(), type: 'drum', drumType: alias,
                                    timeOffset: adjustedTime, duration: adjustedDur,
                                    velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127)))
                                });
                            } else {
                                domainObj.tracks[localIdx].push({
                                    id: Math.random(), 
                                    type: 'play', 
                                    freqs: [masterTune * Math.pow(2, (note.midi - 69) / 12)],
                                    timeOffset: adjustedTime, 
                                    duration: adjustedDur,
                                    velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
                                    synthState: studio.trackSynthStates[targetTrackIdx] // Isolates the track brain
                                });
                            }
                            if (adjustedTime + adjustedDur > trackMaxDur) trackMaxDur = adjustedTime + adjustedDur;
                        });

                        if (!isTargetLooper && trackMaxDur > arranger.duration) arranger.duration = trackMaxDur;
                        if (isTargetLooper && trackMaxDur > looper.trackDurations[localIdx]) looper.trackDurations[localIdx] = trackMaxDur;
                        currentSearchIdx = targetTrackIdx + 1; 
                    }
                } catch (err) {
                    console.error("Failed to parse MIDI file:", err);
                    showToast(`Could not read ${file.name}. It may be corrupted.`);
                }
            }
        }

        if (typeof syncAllTrackRouting === 'function') syncAllTrackRouting();

        updateStudioUI();
        if (typeof drawPianoRoll === 'function') drawPianoRoll();
        showToast("Import complete!");
        e.target.value = '';
    });

    // --- TAURI NATIVE OS INTEGRATION ---
    if (window.__TAURI__) {
        console.log("Native Tauri Environment Detected!");
        try {
            // Safely handle different Tauri versions/injection states without crashing
            const tauriInvoke = (window.__TAURI__.core && window.__TAURI__.core.invoke) || window.__TAURI__.invoke;

            if (tauriInvoke) {
                tauriInvoke('get_samples')
                    .then((files) => {
                        const group = document.getElementById('folderSamplesGroup');
                        if (group && files.length > 0) {
                            files.forEach(file => {
                                const opt = document.createElement('option');
                                opt.value = `sample_folder:samples/${file}`;
                                opt.textContent = `💾 ${file.replace('.wav', '')}`;
                                group.appendChild(opt);
                            });
                        } else if (group) {
                            group.innerHTML = '<option disabled>No .wav files found in /samples/</option>';
                        }
                    })
                    .catch(err => console.error("Tauri FS Error:", err));
            }
        } catch (err) {
            console.warn("Tauri file system integration skipped:", err);
        }
    }

    updateLabels(); updateScaleOverlay(); applyTransform(); drawEnvelope(); centerOnRoot(false);

    // Force UI sync for sliders rendered inside hidden overlays
    const hideSlider = document.getElementById('uiHideDelay');
    if (hideSlider) {
        hideSlider.value = uiHideDelay;
        // Dispatch the input event to force the text label to update instantly!
        hideSlider.dispatchEvent(new Event('input'));
    }

    // Force Theme sync on startup to guarantee colors match the dropdown!
    document.getElementById('themeColorSelect')?.dispatchEvent(new Event('change'));

    // --- VANILLA JS BINARY MIDI ENCODER ---
    function writeVarInt(value) {
        let buffer = [value & 0x7F];
        while ((value >>= 7)) buffer.push((value & 0x7F) | 0x80);
        return buffer.reverse();
    }

    function createMIDIFile(events, bpm, isDrumTrack) {
        const PPQ = 480; // Pulses (ticks) Per Quarter Note
        const ticksPerSecond = (bpm * PPQ) / 60;

        // 1. Flatten all notes into a single timeline of "Note On" and "Note Off" actions
        let midiActions = [];

        events.forEach(evt => {
            const startTick = Math.round(evt.timeOffset * ticksPerSecond);
            const durationTicks = Math.round((evt.duration || 0.5) * ticksPerSecond);

            if (evt.type === 'play' && evt.stArray) {
                evt.stArray.forEach(st => {
                    const note = Math.min(127, Math.max(0, 60 + st)); // Base note C4 (60) + Tonnetz semitone offset
                    midiActions.push({ tick: startTick, type: 0x90, note: note, vel: Math.round(evt.velocity * 127) || 100 });
                    midiActions.push({ tick: startTick + durationTicks, type: 0x80, note: note, vel: 0 });
                });
            } else if (evt.type === 'drum' && evt.drumType) {
                // Map generic drum names to General MIDI Drum Map (Channel 10)
                const drumMap = { 'kick': 36, 'snare': 38, 'hihat': 42, 'clap': 39, 'cymbal': 49, 'tom': 45 };
                const note = drumMap[evt.drumType.toLowerCase()] || 36;
                midiActions.push({ tick: startTick, type: 0x90, note: note, vel: Math.round(evt.velocity * 127) || 100 });
                midiActions.push({ tick: startTick + durationTicks, type: 0x80, note: note, vel: 0 });
            }
        });

        // Sort actions strictly by time
        midiActions.sort((a, b) => a.tick - b.tick);

        // 2. Convert Absolute Ticks to Delta Ticks (Time since last event)
        let trackData = [];
        let lastTick = 0;

        // Channel 9 (0-indexed) is the General MIDI standard for Drums
        const channel = isDrumTrack ? 0x09 : 0x00;

        midiActions.forEach(action => {
            const delta = action.tick - lastTick;
            trackData.push(...writeVarInt(delta));
            trackData.push(action.type | channel, action.note, action.vel);
            lastTick = action.tick;
        });

        // End of Track Meta Event
        trackData.push(0x00, 0xFF, 0x2F, 0x00);

        // 3. Construct the Binary File Headers
        const headerChunk = [
            0x4D, 0x54, 0x68, 0x64, // MThd
            0x00, 0x00, 0x00, 0x06, // Chunk length (6 bytes)
            0x00, 0x00,             // Format 0 (Single Track)
            0x00, 0x01,             // 1 Track
            (PPQ >> 8) & 0xFF, PPQ & 0xFF // Division (Ticks per Quarter Note)
        ];

        const trackHeader = [
            0x4D, 0x54, 0x72, 0x6B, // MTrk
            (trackData.length >> 24) & 0xFF, (trackData.length >> 16) & 0xFF,
            (trackData.length >> 8) & 0xFF, trackData.length & 0xFF
        ];

        return new Uint8Array([...headerChunk, ...trackHeader, ...trackData]);
    }

    // =====================================================================
    // 8-KNOB MACRO DASHBOARD ENGINE
    // =====================================================================
    const macroRegistry = [
        { id: 'brightness', name: 'Cutoff', min: 1, max: 8, suffix: '' },
        { id: 'resonance', name: 'Resonance', min: 0, max: 20, suffix: '' },
        { id: 'attack', name: 'Attack', min: 0.01, max: 1, suffix: 's' },
        { id: 'release', name: 'Release', min: 0.05, max: 3, suffix: 's' },
        { id: 'lfoSpeed', name: 'LFO Speed', min: 0.1, max: 20, suffix: 'hz' },
        { id: 'vibrato', name: 'Vibrato', min: 0, max: 100, suffix: '%' },
        { id: 'sweep', name: 'Filter Sweep', min: 0, max: 2400, suffix: '' },
        { id: 'tremolo', name: 'Tremolo', min: 0, max: 1, suffix: '' },
        { id: 'distortion', name: 'Distortion', min: 0, max: 100, suffix: '%' },
        { id: 'chorus', name: 'Chorus', min: 0, max: 30, suffix: '' },
        { id: 'echo', name: 'Echo Mix', min: 0, max: 0.5, suffix: '' },
        { id: 'reverbMix', name: 'Reverb Mix', min: 0, max: 1, suffix: '' },
        { id: 'oscMix', name: 'Osc Mix', min: 0, max: 1, suffix: '' },
        { id: 'subOsc', name: 'Sub Level', min: 0, max: 1, suffix: '' },
        { id: 'arpBpm', name: 'Master BPM', min: 40, max: 240, suffix: '' }
    ];

    const defaultMacros = [
        'brightness', 'resonance', 'lfoSpeed', 'vibrato',
        'distortion', 'oscMix', 'echo', 'reverbMix'
    ];

    const knobState = new Array(8).fill(null).map(() => ({
        targetId: '', min: 0, max: 1, value: 0, suffix: ''
    }));

    function initMacros() {
        for (let i = 1; i <= 8; i++) {
            const selectEl = document.getElementById(`macro-sel-${i}`);
            if (!selectEl) continue;

            selectEl.innerHTML = ''; // Clear previous options just in case

            // Populate the sleek borderless dropdowns
            macroRegistry.forEach(param => {
                const opt = document.createElement('option');
                opt.value = param.id;
                opt.textContent = param.name;
                selectEl.appendChild(opt);
            });

            // Assign defaults
            selectEl.value = defaultMacros[i - 1];
            assignMacroParam(i, defaultMacros[i - 1]);

            // Handle user re-assignment
            selectEl.addEventListener('change', (e) => assignMacroParam(i, e.target.value));

            // Attach Vertical Drag physics
            setupKnobPhysics(i);
        }
    }

function assignMacroParam(knobIndex, targetId) {
        const param = macroRegistry.find(p => p.id === targetId);
        if (!param) return;

        // Fetch the CURRENT live value from the actual HTML slider!
        const sourceSlider = document.getElementById(param.id);
        const liveVal = sourceSlider ? parseFloat(sourceSlider.value) : param.min;

        knobState[knobIndex - 1] = {
            targetId: param.id,
            min: param.min,
            max: param.max,
            value: liveVal,
            suffix: param.suffix
        };

        updateKnobVisuals(knobIndex);
        
        // Check if the newly assigned target is currently disabled!
        const cell = document.getElementById(`macro-knob-${knobIndex}`)?.closest('.macro-cell');
        if (cell && sourceSlider) {
            cell.classList.toggle('disabled', sourceSlider.disabled);
        }
    }

    function setupKnobPhysics(knobIndex) {
        const knob = document.getElementById(`macro-knob-${knobIndex}`);
        if (!knob) return;

        let startY = 0;
        let startVal = 0;
        let isDragging = false;

        const startDrag = (e) => {
            isDragging = true;
            isMacroDragging = true; // Lock Tonnetz
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            startVal = knobState[knobIndex - 1].value;
            document.body.style.cursor = 'ns-resize';
            e.preventDefault();
        };

        const onDrag = (e) => {
            if (!isDragging) return;
            const y = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const deltaY = startY - y; 

            const state = knobState[knobIndex - 1];
            const range = state.max - state.min;
            const deltaVal = (deltaY / 150) * range; 
            
            let newVal = startVal + deltaVal;
            newVal = Math.max(state.min, Math.min(state.max, newVal));
            state.value = newVal;

            updateKnobVisuals(knobIndex);
            const targetSlider = document.getElementById(state.targetId);
            if (targetSlider) {
                targetSlider.value = newVal;
                targetSlider.dispatchEvent(new Event('input'));
            }
        };

        const stopDrag = () => {
            if (isDragging) {
                isDragging = false;
                isMacroDragging = false; // Unlock Tonnetz
                document.body.style.cursor = 'default';
            }
        };

        // NEW FEATURE: Mouse Scroll Support!
        knob.addEventListener('wheel', (e) => {
            e.preventDefault();
            const state = knobState[knobIndex - 1];
            const range = state.max - state.min;
            
            // Scroll up = increase, Scroll down = decrease (5% steps)
            const deltaVal = (e.deltaY > 0 ? -1 : 1) * (range * 0.05); 
            let newVal = state.value + deltaVal;
            newVal = Math.max(state.min, Math.min(state.max, newVal));
            state.value = newVal;
            
            updateKnobVisuals(knobIndex);
            const targetSlider = document.getElementById(state.targetId);
            if (targetSlider) {
                isMacroDragging = true; // THE FIX: Lock the global sync listener briefly!
                targetSlider.value = newVal;
                targetSlider.dispatchEvent(new Event('input'));
                isMacroDragging = false; // Unlock
            }
        }, { passive: false });

        knob.addEventListener('mousedown', startDrag);
        knob.addEventListener('touchstart', startDrag, { passive: false });
        window.addEventListener('mousemove', onDrag);
        window.addEventListener('touchmove', onDrag, { passive: false });
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchend', stopDrag);
    }

    function updateKnobVisuals(knobIndex) {
        const state = knobState[knobIndex - 1];
        const percent = (state.value - state.min) / (state.max - state.min);

        // GEOMETRY FIX: Bump offset to 213 to completely kill the green bleed!
        const dashOffset = 213 * (1 - percent);
        const valPath = document.getElementById(`macro-val-${knobIndex}`);
        if (valPath) valPath.style.strokeDashoffset = dashOffset;

        // Since the SVG pointer line now starts exactly at bottom-left (135 deg), 
        // 0% is 0 rotation, and 100% is 270 degrees clockwise!
        const degrees = percent * 270;
        const ptr = document.getElementById(`macro-ptr-${knobIndex}`);
        if (ptr) {
            // THE FIX: Explicitly set the rotation origin to 50, 50!
            ptr.setAttribute('transform', `rotate(${degrees}, 50, 50)`);
        }

        // Format Text
        const txt = document.getElementById(`macro-text-${knobIndex}`);
        if (txt) {
            let displayVal = state.value;
            if (state.max > 10) displayVal = Math.round(displayVal);
            else displayVal = displayVal.toFixed(2);
            txt.textContent = `${displayVal}${state.suffix}`;
        }
    }

    // =====================================================================
    // --- TWO-WAY BINDING: Sync Macros from Sliders ---
    // =====================================================================

    // 1. Programmatic Sync (Used when presets load)
    function syncAllMacros() {
        if (typeof knobState === 'undefined') return;
        for (let i = 1; i <= 8; i++) {
            const state = knobState[i - 1];
            if (state && state.targetId) {
                const slider = document.getElementById(state.targetId);
                if (slider) {
                    state.value = parseFloat(slider.value);
                    updateKnobVisuals(i);
                    
                    // Inherit the disabled state from the target HTML slider!
                    const cell = document.getElementById(`macro-knob-${i}`)?.closest('.macro-cell');
                    if (cell) cell.classList.toggle('disabled', slider.disabled);
                }
            }
        }
    }

    // 2. Physical Sync (Used when the user manually drags a synth slider)
    document.addEventListener('input', (e) => {
        if (typeof isMacroDragging !== 'undefined' && isMacroDragging) return;
        if (!e.target || !e.target.id) return;
        
        if (typeof knobState === 'undefined') return;
        const targetId = e.target.id;
        for (let i = 1; i <= 8; i++) {
            if (knobState[i - 1].targetId === targetId) {
                knobState[i - 1].value = parseFloat(e.target.value);
                updateKnobVisuals(i);
            }
        }
    });

    // =====================================================================
    // PIANO ROLL UI & NAVIGATION
    // =====================================================================

    function initPianoRoll() {
        const prCanvas = document.getElementById('pr-canvas');
        if (prCanvas) {
            prCanvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                wakeNav();

                if (e.ctrlKey || e.metaKey) {
                    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                    prZoomY = Math.max(20, Math.min(prZoomY * zoomFactor, 500));
                    
                    // Sync the UI slider if it exists
                    const zSlider = document.getElementById('prZoomSlider');
                    if (zSlider) zSlider.value = prZoomY; 
                    
                    if (typeof drawPianoRoll === 'function') drawPianoRoll(); // Force redraw on wheel zoom
                }
                else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                    t_panX -= e.deltaX;
                    applyTransform();
                }
                else {
                    // Vertical Scroll (Standard Scroll) - Moves up and down in Time
                    const timeShift = e.deltaY / prZoomY;
                    prScrollTime = Math.max(0, prScrollTime + timeShift);

                    // --- Kill Auto-Scroll if user manually scrolls! ---
                    if (isPrAutoScroll) {
                        isPrAutoScroll = false;
                        document.getElementById('btnPrAutoScroll')?.classList.remove('active');
                    }
                }
            }, { passive: false });
        }

        // =========================================================================
        // PIANO ROLL VERTICAL RESIZING
        // =========================================================================
        const prResizeHandle = document.getElementById('pr-resize-handle');
        const prOverlay = document.getElementById('piano-roll-overlay');

        let isResizingPR = false;
        let prStartY = 0;
        let prStartHeight = 0;

        const startResizePR = (e) => {
            isResizingPR = true;
            prStartY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
            prStartHeight = prOverlay.getBoundingClientRect().height;
        
            // 1. Prevent text highlighting
            document.body.style.userSelect = 'none';
        
            // 2. APPLY THE SHIELD: Prevents Tonnetz from playing accidental notes
            document.body.classList.add('is-resizing-pr');
        };

        const doResizePR =(e) => {
            if (!isResizingPR) return;
            const currentY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;

            // Use the exact HTML IDs from your document!
            const masterTransport = document.getElementById('master-transport');
            const canvasControls = document.getElementById('canvas-controls');

            // =========================================================
            // --- 1. DETECT TOP-LEVEL UI INTERFERENCE ---
            // =========================================================
            const interferenceThreshold = 140; 
            const isPRHigh = currentY < interferenceThreshold;
            const isMobile = window.innerWidth <= 768;

            if (isPRHigh) {
                if (masterTransport) masterTransport.classList.add('pr-high');
                // ONLY stretch the D-Pad if we are NOT on a mobile device
                if (canvasControls && !isMobile) canvasControls.classList.add('pr-high-stretched');
            } else {
                if (masterTransport) masterTransport.classList.remove('pr-high');
                if (canvasControls) canvasControls.classList.remove('pr-high-stretched');
            }

            // =========================================================
            // --- 2. DYNAMIC STACKING CLAMP ---
            // =========================================================
            const macroOverlay = document.getElementById('macro-overlay');
            const isMacroOpen = macroOverlay?.classList.contains('active');
        
            let safeTopMargin = 0;
        
            // 1. Measure top docked headers (Transport + D-Pad)
            if (isPRHigh || isMobile) {
                const mtHeight = masterTransport ? masterTransport.offsetHeight : 45;
                const menuHeight = canvasControls ? canvasControls.offsetHeight : 50;
                safeTopMargin += (mtHeight + menuHeight - 2); 
            }
            
            // 2. Measure the Macro Panel if it is active! (Removes the fatal 'else')
            if (isMacroOpen) {
                // Dynamically read its height so it supports wrapping on small screens
                safeTopMargin += macroOverlay ? macroOverlay.offsetHeight : 90;
            }

            const pianoH = document.getElementById('piano-overlay') ? document.getElementById('piano-overlay').offsetHeight : 0;
        
            // Calculate max allowed height based on our new pixel-perfect hard-stop margin
            const maxHeight = window.innerHeight - pianoH - safeTopMargin;

            // Apply the height and strictly clamp it
            let newHeight = window.innerHeight - currentY - pianoH;
            newHeight = Math.max(40, Math.min(newHeight, maxHeight));
        
            // Write directly to your global CSS variables
            document.documentElement.style.setProperty('--pr-height', `${newHeight}px`);
            document.documentElement.style.setProperty('--pr-actual-h', `${newHeight}px`);

            // If the Piano Roll covers more than 60% of the screen height, eliminate the Tonnetz peephole
            const isCoveringScreen = newHeight / window.innerHeight > 0.60;
            document.body.classList.toggle('pr-maximized', isCoveringScreen);

            // --- IMPORTANT: Trigger collision checks dynamically while dragging! ---
            if (typeof evaluatePanelCollisions === 'function') evaluatePanelCollisions(); 

            if (typeof updateOverlayCSSVars === 'function') updateOverlayCSSVars();
            if (typeof resizePianoRollCanvas === 'function') resizePianoRollCanvas();
        };

        const stopResizePR = () => {
            if (isResizingPR) {
                isResizingPR = false;
                // 4. REMOVE THE SHIELD: Tonnetz is playable again
                document.body.classList.remove('is-resizing-pr');
                document.body.style.userSelect = ''; 
            }
        };

        if (prResizeHandle) {
            prResizeHandle.addEventListener('mousedown', startResizePR);
            prResizeHandle.addEventListener('touchstart', startResizePR, { passive: false });
        }

        window.addEventListener('mousemove', doResizePR);
        window.addEventListener('mouseup', stopResizePR);
        window.addEventListener('touchmove', doResizePR, { passive: false });
        window.addEventListener('touchend', stopResizePR);

        // --- TOOLBAR LISTENERS ---

        document.getElementById('prZoomSlider')?.addEventListener('input', (e) => {
            prZoomY = parseFloat(e.target.value);
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
        });

        document.getElementById('btnPrAutoScroll')?.addEventListener('click', (e) => {
            isPrAutoScroll = !isPrAutoScroll;
            e.target.classList.toggle('active', isPrAutoScroll);
        });

        document.getElementById('prSnapGrid')?.addEventListener('change', (e) => {
            prSnapRes = parseFloat(e.target.value);
        });

        // --- Tool UI Toggling ---
        const tools = ['Select', 'Copy', 'Draw', 'Erase', 'Region']; 
        tools.forEach(tool => {
            const btn = document.getElementById(`prTool${tool}`);
            if (btn) {
                btn.addEventListener('click', (e) => {
                    currentPrTool = tool.toLowerCase();
                    tools.forEach(t => {
                        const otherBtn = document.getElementById(`prTool${t}`);
                        if (otherBtn) otherBtn.classList.remove('active');
                    });
                    
                    e.target.classList.add('active');
                });
            }
        });

        // Re-engage Auto-Scroll whenever ANY play button is clicked
        ['btnLooperPlay', 'btnArrangerPlay', 'btn-import-play', 'btn-rec-play'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', () => {
                isPrAutoScroll = true;
                document.getElementById('btnPrAutoScroll')?.classList.add('active');
            });
        });
    }

    // --- STEP ENTRY LOGIC HANDLERS ---
    function handleStepEntry(freqs, originalStArray, drumType = null, velocity = 1, timeOverride = null, durationOverride = null) {
        let activeDomain = studio.lastSelectedDomain;
        let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
        let domainObj = activeDomain === 'looper' ? looper : arranger;
        let localIdx = activeDomain === 'looper' ? activeIdx : activeIdx - 8;

        const beatSecs = 60 / currentArpBPM;
        const defaultStepDur = prSnapRes > 0 ? (beatSecs * prSnapRes) : (beatSecs * 0.25);
        
        // Use overrides if provided by the AI, otherwise use manual step entry defaults
        const targetTime = timeOverride !== null ? timeOverride : stepCursorTime;
        const targetDur = durationOverride !== null ? durationOverride : defaultStepDur;
        
        // Parse velocity correctly (default 100 for synths if not specified)
        const parsedVelocity = velocity !== 1 ? velocity : 100;

        // Sync track metadata on first entry!
        if (studio.trackTypes[activeIdx] === null) {
            syncActiveTrackInstrument(drumType);
        }

        let createdEvts = []; // NEW: Array to catch the events

        if (drumType) {
            const evt = {
                id: Math.random(), timeOffset: targetTime, duration: targetDur, type: 'drum', drumType: drumType, velocity: velocity === 1 ? 1 : parsedVelocity
            };
            domainObj.tracks[localIdx].push(evt);
            createdEvts.push(evt); // Catch it
        } else {
            const synthState = captureCurrentSynthState();
            
            // Explode the chord! Drop every note individually.
            freqs.forEach((f, i) => {
                // Prevent duplicates: Check if this exact note already exists at the cursor
                const exists = domainObj.tracks[localIdx].some(evt =>
                    evt.type === 'play' &&
                    Math.abs(evt.timeOffset - targetTime) < 0.001 &&
                    evt.freqs && evt.freqs.some(existingF => Math.abs(existingF - f) < 0.1)
                );

                if (!exists) {
                    const singleSt = originalStArray && originalStArray[i] !== undefined ? [originalStArray[i]] : null;
                    const evt = {
                        id: Math.random(), freqs: [f], timeOffset: targetTime, 
                        type: 'play', stArray: singleSt, 
                        velocity: parsedVelocity, // Humanized AI velocity applied here
                        duration: targetDur, synthState: synthState 
                    };
                    domainObj.tracks[localIdx].push(evt);
                    createdEvts.push(evt); // Catch it
                }
            });
        }

        if (activeDomain === 'looper' && targetTime + targetDur > (looper.trackDurations[localIdx] || 0)) {
            looper.trackDurations[localIdx] = targetTime + targetDur;
        } else if (activeDomain === 'arranger' && targetTime + targetDur > arranger.duration) {
            arranger.duration = targetTime + targetDur;
        }

        // Only auto-scroll the Piano Roll if we are doing manual step entry
        if (timeOverride === null) {
            prScrollTime = Math.max(0, targetTime - (prCanvas.height / (window.devicePixelRatio || 1) / prZoomY) * 0.25);
        }
        
        if (typeof drawPianoRoll === 'function') drawPianoRoll();

        // Return the events so the dynamic duration engine can stretch them!
        return createdEvts;
    }

    function advanceStepCursor(actualDuration = null) {
        if (!isStepEntryMode) return;
        
        const beatSecs = 60 / currentArpBPM;
        const currentSnap = parseFloat(prSnapRes);
        
        // 1. If a note was recorded, advance by its EXACT calculated duration
        if (actualDuration !== null && actualDuration > 0) {
            stepCursorTime += actualDuration;
        } 
        // 2. Fallback: Manual ⏭ button clicks advance by 1 grid unit
        else {
            const stepDur = currentSnap > 0 ? (beatSecs * currentSnap) : (beatSecs * 0.25);
            stepCursorTime += stepDur;
        }
        
        // Auto-scroll the piano roll to keep the cursor in view
        const dpr = window.devicePixelRatio || 1;
        prScrollTime = Math.max(0, stepCursorTime - (prCanvas.height / dpr / prZoomY) * 0.25);
        
        if (typeof drawPianoRoll === 'function') drawPianoRoll();
    }

    document.getElementById('prToolStep')?.addEventListener('click', (e) => {
        isStepEntryMode = !isStepEntryMode;
        
        if (isStepEntryMode) {
            let activeDomain = studio.lastSelectedDomain;
            stepCursorTime = activeDomain === 'arranger' ? arranger.pauseTime : 0;
            stepCursorTime = snapTime(stepCursorTime);
            stopMasterPlayback();
        }

        e.target.classList.toggle('active', isStepEntryMode);
        const displayStyle = isStepEntryMode ? 'inline-block' : 'none';
        const btnRest = document.getElementById('prStepRest');
        const btnBack = document.getElementById('prStepBack');
        if (btnRest) btnRest.style.display = displayStyle;
        if (btnBack) btnBack.style.display = displayStyle;
        
        if (typeof drawPianoRoll === 'function') drawPianoRoll();
    });

    // =========================================================================
    // PIANO ROLL TRACK LABEL UPDATER
    // =========================================================================
    function updatePianoRollTrackLabel() {
        const labelEl = document.getElementById('pr-track-label');
        if (!labelEl || typeof studio === 'undefined') return;

        // 1. Figure out which track is currently active
        const domain = studio.lastSelectedDomain;
        const trackIdx = domain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
    
        const prefix = domain === 'looper' ? 'L' : 'A';
        const displayNum = domain === 'looper' ? (trackIdx + 1) : (trackIdx - 7);
    
        // 2. Steal the instrument name directly from the Mixer DOM
        const instLabelEl = document.getElementById(`inst-label-${trackIdx}`);
        const instName = instLabelEl ? instLabelEl.textContent : 'EMPTY';
    
        // 3. Update the text
        labelEl.textContent = `${prefix}${displayNum} - ${instName}`;
    
        // 4. (Optional Polish) Match the label color to your global trackColors array
        if (typeof trackColors !== 'undefined' && trackColors[trackIdx]) {
            labelEl.style.color = trackColors[trackIdx];
            labelEl.style.borderColor = trackColors[trackIdx] + '80'; // Adds 50% opacity hex to the border
        } else {
            labelEl.style.color = 'white';
            labelEl.style.borderColor = 'rgba(255,255,255,0.2)';
        }
    }

    // =========================================================================
    // PIANO ROLL LABEL AUTO-SYNC (Mutation Observer)
    // =========================================================================
    const trackLabelObserver = new MutationObserver(() => {
        // Only bother doing the math if the Piano Roll is actually open
        if (typeof updatePianoRollTrackLabel === 'function' && typeof isPianoRollActive !== 'undefined' && isPianoRollActive) {
            updatePianoRollTrackLabel();
        }
    });

    // Attach the observer to all tiny mixer labels in the DOM
    document.querySelectorAll('.inst-label').forEach(label => {
        trackLabelObserver.observe(label, { 
            childList: true, 
            characterData: true, 
            subtree: true 
        });
    });

    // =====================================================================
    // --- PIANO ROLL CLIPBOARD (Copy & Paste) ---
    // =====================================================================
    document.addEventListener('keydown', (e) => {
        // Only trigger if Piano Roll is open and user is holding Ctrl or Cmd (Mac)
        if (!isPianoRollActive || (!e.ctrlKey && !e.metaKey)) return;

        // --- COPY (Ctrl + C) ---
        if (e.code === 'KeyC') {
            if (prSelectedNotes.size === 0) return;
            
            // 1. Find "Time Zero" (the absolute earliest note in the selection)
            let timeZero = Infinity;
            prSelectedNotes.forEach(evt => {
                const t = evt.start !== undefined ? evt.start : evt.timeOffset;
                if (t < timeZero) timeZero = t;
            });

            // 2. Clone the notes and convert to Relative Time
            prClipboard = [];
            prSelectedNotes.forEach(evt => {
                let clone = { ...evt, id: Math.random() }; // Deep copy top level
                
                // Safely duplicate nested arrays so modifying the paste doesn't break the original
                if (evt.freqs) clone.freqs = [...evt.freqs];
                if (evt.stArray) clone.stArray = [...evt.stArray];

                // Convert absolute timeline placement into relative clipboard placement
                if (clone.start !== undefined) {
                    const dur = clone.end - clone.start;
                    clone.start = clone.start - timeZero;
                    clone.end = clone.start + dur;
                } else {
                    clone.timeOffset = clone.timeOffset - timeZero;
                }
                
                prClipboard.push(clone);
            });

            showToast(`Copied ${prClipboard.length} items.`);
            e.preventDefault();
        }

        // --- PASTE (Ctrl + V) ---
        if (e.code === 'KeyV') {
            if (prClipboard.length === 0) return;

            const activeDomain = studio.lastSelectedDomain;
            const activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            const targetTrack = activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8];
            const isDrumTrack = studio.trackTypes[activeIdx] === 'drum';
            
            // 1. Determine Paste Anchor Time
            let anchorTime = 0;
            if (typeof isStepEntryMode !== 'undefined' && isStepEntryMode) {
                anchorTime = stepCursorTime; // Paste at the blue Step Cursor
            } else if (activeDomain === 'arranger') {
                // Paste at the red playhead (or wherever it is paused)
                anchorTime = arranger.isPlaying ? (audioCtx ? audioCtx.currentTime - arranger.startTime : 0) : arranger.pauseTime;
            } else if (activeDomain === 'looper') {
                anchorTime = looper.isPlaying ? looper.lastPhases[activeIdx] : 0;
            }
            
            // Snap the anchor so pasted blocks align perfectly to the grid!
            anchorTime = snapTime(anchorTime);

            // 2. Deselect old notes so ONLY the newly pasted notes are highlighted
            prSelectedNotes.clear(); 
            let draggedMaxTime = 0;

            // 3. Inject Clipboard contents
            prClipboard.forEach(clipEvt => {
                // Domain Safety: Do not paste synth chords into the Drum Machine (or vice versa)
                if (isDrumTrack && clipEvt.type !== 'drum') return;
                if (!isDrumTrack && clipEvt.type === 'drum') return;

                let newEvt = { ...clipEvt, id: Math.random() };
                if (clipEvt.freqs) newEvt.freqs = [...clipEvt.freqs];
                if (clipEvt.stArray) newEvt.stArray = [...clipEvt.stArray];

                // Route Regions to Looper Arrays, and Notes to standard Arrays
                if (newEvt.start !== undefined && activeDomain === 'looper') {
                    const dur = newEvt.end - newEvt.start;
                    newEvt.start = anchorTime + clipEvt.start;
                    newEvt.end = newEvt.start + dur;
                    looper.regions[activeIdx].push(newEvt);
                    if (newEvt.end > draggedMaxTime) draggedMaxTime = newEvt.end;
                } else if (newEvt.timeOffset !== undefined) {
                    newEvt.timeOffset = anchorTime + clipEvt.timeOffset;
                    targetTrack.push(newEvt);
                    const endT = newEvt.timeOffset + (newEvt.duration || 0.25);
                    if (endT > draggedMaxTime) draggedMaxTime = endT;
                }

                prSelectedNotes.add(newEvt); // Auto-select the newly pasted notes!
            });

            // 4. Clean up track arrays
            targetTrack.sort((a, b) => a.timeOffset - b.timeOffset);

            // 5. Instantly expand global timeline if pasted beyond current length
            if (activeDomain === 'arranger' && draggedMaxTime > arranger.duration) {
                arranger.duration = draggedMaxTime;
            }

            showToast(`Pasted ${prSelectedNotes.size} items.`);
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
            e.preventDefault();
        }
    });

    // =====================================================================
    // --- PIANO ROLL TOOL SWITCHING & PLAYHEAD PLACEMENT ---
    // =====================================================================

    // Helper: Updates Master LCD and Slider when the playhead teleports
    function syncTransportToTime(timeSecs) {
        if (globalSeeker) {
            let maxDuration = Math.max(arranger.duration, ...looper.trackDurations);
            if (maxDuration > 0) globalSeeker.value = Math.min(100, (timeSecs / maxDuration) * 100);
        }
        if (globalTimeDisplay) {
            const beatSecs = 60 / currentArpBPM;
            const totalBeats = Math.max(0, timeSecs / beatSecs); 
            const bars = Math.floor(totalBeats / beatsPerBar) + 1;
            const beats = Math.floor(totalBeats % beatsPerBar) + 1;
            globalTimeDisplay.textContent = `${bars}.${beats}`;
            
            // Reset chord memory so it doesn't smear across the teleport!
            currentPlaybackBar = bars;
            noteMemoryMap.clear();
        }
    }

    // Mutually Exclusive Tool Logic
    const prTools = [
        { id: 'prToolSelect', tool: 'select', step: false },
        { id: 'prToolCopy', tool: 'copy', step: false },
        { id: 'prToolDraw', tool: 'draw', step: false },
        { id: 'prToolErase', tool: 'erase', step: false },
        { id: 'prToolRegion', tool: 'region', step: false },
        { id: 'prToolStep', tool: 'select', step: true } // Step mode uses 'select' physics under the hood
    ];

    prTools.forEach(config => {
        const btn = document.getElementById(config.id);
        if (!btn) return;
        btn.addEventListener('click', () => {
            // 1. Visually reset all buttons, then highlight the clicked one
            prTools.forEach(t => document.getElementById(t.id)?.classList.remove('active'));
            btn.classList.add('active');

            // 2. Set the Global States
            currentPrTool = config.tool;
            isStepEntryMode = config.step;
            if (typeof prSelectedNotes !== 'undefined') prSelectedNotes.clear(); // Clear selections safely
            
            // 3. Delegate ALL contextual UI toggling to the helper function!
            if (typeof updatePrToolbarUI === 'function') updatePrToolbarUI(config.id);

            if (typeof drawPianoRoll === 'function') drawPianoRoll();
        });
    });

    function updatePrToolbarUI(activeButtonId) {
        const contextTools = document.getElementById('prContextTools');
        const stepTools = document.getElementById('prStepTools');

        // Toggle Select Tool Actions (Snap, Legato)
        if (contextTools) {
            contextTools.style.display = (activeButtonId === 'prToolSelect') ? 'flex' : 'none';
        }

        // Toggle Step Tool Actions (Back, Rest)
        if (stepTools) {
            stepTools.style.display = (activeButtonId === 'prToolStep') ? 'flex' : 'none';
        }
    }

    // ==========================================
    // INDEXED-DB SAMPLE MANAGER
    // ==========================================
    const DB_NAME = 'TonnetzProDB';
    const STORE_NAME = 'custom_samples';

    function initSampleDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) return reject("IndexedDB not supported");
            try {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'name' });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (err) {
                reject("IndexedDB Security Block: " + err);
            }
        });
    }

    async function saveSampleToDB(file) {
        try {
            const db = await initSampleDB();
            const arrayBuffer = await file.arrayBuffer();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            // Save the raw binary data with the filename
            store.put({ name: file.name, data: arrayBuffer });

            return new Promise((resolve) => {
                tx.oncomplete = () => {
                    refreshSavedSamplesUI();
                    resolve();
                };
            });
        } catch (err) {
            console.error("DB Save Error:", err);
        }
    }

    async function loadSampleFromDB(name) {
        try {
            const db = await initSampleDB();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(name);

            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result ? request.result.data : null);
                request.onerror = () => reject(request.error);
            });
        } catch (err) {
            console.error("DB Load Error:", err);
            return null;
        }
    }

    async function refreshSavedSamplesUI() {
        try {
            const db = await initSampleDB();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAllKeys();

            request.onsuccess = () => {
                const keys = request.result;
                const group = document.getElementById('folderSamplesGroup');
                if (!group) return;

                // Clear existing DB entries
                group.innerHTML = '';
                group.label = "--- USER SAMPLES ---";

                // 1. Populate saved samples from the database
                if (keys.length > 0) {
                    keys.forEach(key => {
                        const opt = document.createElement('option');
                        opt.value = `sample_db:${key}`;
                        opt.textContent = `💾 ${key.replace('.wav', '')}`;
                        group.appendChild(opt);
                    });
                }

                // 2. ALWAYS append the Custom Upload button at the bottom of this group!
                const customOpt = document.createElement('option');
                customOpt.value = 'sample_custom';
                customOpt.textContent = '📂 Browse / Custom Sample...';
                customOpt.style.fontWeight = 'bold';
                group.appendChild(customOpt);
            };
        } catch (err) {
            console.error("DB UI Refresh Error:", err);
        }
    }

    // Initialize the UI on boot
    window.addEventListener('DOMContentLoaded', () => {
        refreshSavedSamplesUI();
        updateLabels();
        updateScaleOverlay();

        // --- MASTER STARTUP UI INITIALIZATION ---
        // Force the synth engine to load the physics for the default instrument (Piano)
        const presetEl = document.getElementById('instrumentPreset');
        if (presetEl) {
            presetEl.value = 'piano';
            presetEl.dispatchEvent(new Event('change'));
        }

        initPianoRoll();
        initMacros();

        // Visually highlight the Piano/Synth button on the D-Pad by default
        const defaultNavBtn = document.getElementById('btnTogglePiano');
        if (defaultNavBtn) defaultNavBtn.classList.add('active-btn');

        const wrapper = document.getElementById('tonnetz-wrapper');
        if (wrapper) tonnetzObserver.observe(wrapper);
        resizeTonnetzSvg();
    });

    // --- PWA SERVICE WORKER REGISTRATION ---
    // Only attempt to register if hosted securely or on localhost (prevents file:/// crashes)
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.protocol === 'http:')) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').then(registration => {
                console.log('Tonnetz Pro is ready for offline use! Scope:', registration.scope);
            }).catch(err => {
                console.warn('Service Worker registration failed:', err);
            });
        });
    }

    document.getElementById('boot-status')?.remove();

    // =====================================================================
    // STEP 9: VELOCITY LANE RESIZE & EDITING LOGIC (RIGHT-SIDE)
    // =====================================================================
    const prVelDivider = document.getElementById('pr-vel-divider');
    const prVelWrapper = document.getElementById('pr-vel-wrapper');
    const prMainWrapper = document.getElementById('pr-main-wrapper');
    let isDraggingVelDivider = false;
    let isEditingVelocity = false;

    // --- 1. DIVIDER DRAGGING (Horizontal) ---
    prVelDivider?.addEventListener('mousedown', () => isDraggingVelDivider = true);
    prVelDivider?.addEventListener('touchstart', () => isDraggingVelDivider = true, { passive: true });
    window.addEventListener('mouseup', () => { isDraggingVelDivider = false; isEditingVelocity = false; });
    window.addEventListener('touchend', () => { isDraggingVelDivider = false; isEditingVelocity = false; });

    window.addEventListener('mousemove', (e) => handleVelDragAndEdit(e));
    window.addEventListener('touchmove', (e) => handleVelDragAndEdit(e.touches[0]), { passive: true });

    function handleVelDragAndEdit(e) {
        // Resizing the Lane
        if (isDraggingVelDivider && prVelWrapper) {
            const prContainer = document.getElementById('pr-container');
            if (!prContainer) return;
            const containerRect = prContainer.getBoundingClientRect();
            let newVelWidth = containerRect.right - e.clientX;
            newVelWidth = Math.max(20, Math.min(newVelWidth, containerRect.width * 0.4));
            prVelWrapper.style.width = `${newVelWidth}px`;
            return;
        }

        // Editing Velocities
        if (isEditingVelocity && isPianoRollActive && velCanvas) {
            const rect = velCanvas.getBoundingClientRect();

            // X-Axis = Velocity (0.0 to 1.0)
            let targetVel = (e.clientX - rect.left) / rect.width;
            
            // THE FIX: Standardize everything to a strict 1-127 integer scale!
            const newVel = Math.max(1, Math.min(127, Math.round(targetVel * 127)));

            const clickTime = getPrTimeFromY(e.clientY - rect.top);
            const timeTolerance = 8 / prZoomY;

            let activeDomain = typeof studio !== 'undefined' ? studio.lastSelectedDomain : 'arranger';
            let activeIdx = activeDomain === 'looper' ? studio.activeLooperTrack : studio.activeArrangerTrack;
            let activeTrack = (activeDomain === 'looper' ? looper.tracks[activeIdx] : arranger.tracks[activeIdx - 8]) || [];

            if (typeof prSelectedNotes !== 'undefined' && prSelectedNotes.size > 0) {
                prSelectedNotes.forEach(evt => evt.velocity = newVel);
            } else {
                activeTrack.forEach(evt => {
                    if (Math.abs(clickTime - evt.timeOffset) <= timeTolerance) {
                        evt.velocity = newVel;
                    }
                });
            }
            if (typeof drawPianoRoll === 'function') drawPianoRoll();
        }
    }

    velCanvas?.addEventListener('mousedown', (e) => { isEditingVelocity = true; handleVelDragAndEdit(e); });
    velCanvas?.addEventListener('touchstart', (e) => { isEditingVelocity = true; handleVelDragAndEdit(e.touches[0]); }, { passive: true });

    // --- 2. AUTONOMOUS CANVAS RESIZER ---
    const prResizeObserver = new ResizeObserver(() => {
        if (!isPianoRollActive) return;
        const dpr = window.devicePixelRatio || 1;

        if (prMainWrapper && typeof prCanvas !== 'undefined') {
            prCanvas.width = prMainWrapper.clientWidth * dpr;
            prCanvas.height = prMainWrapper.clientHeight * dpr;
            if (typeof prCtx !== 'undefined' && prCtx) prCtx.scale(dpr, dpr);
        }

        if (velCanvas && prVelWrapper) {
            velCanvas.width = prVelWrapper.clientWidth * dpr;
            velCanvas.height = prVelWrapper.clientHeight * dpr;
            const velCtx = velCanvas.getContext('2d');
            if (velCtx) velCtx.scale(dpr, dpr);
        }

        if (typeof drawPianoRoll === 'function') drawPianoRoll();
    });

    if (prMainWrapper) prResizeObserver.observe(prMainWrapper);
    if (prVelWrapper) prResizeObserver.observe(prVelWrapper);

})(); // end of scope