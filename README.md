<div align="center">
  <img src="src-tauri/icons/Square310x310Logo.png" alt="Tonnetz Pro Logo" width="180" height="180"/>
  <h1>Tonnetz Pro</h1>
  <p>A music theory workstation, synthesizer, and live performance environment based on Euler's Tonnetz.</p>
</div>

---

Tonnetz Pro maps harmonic relationships to physical space, allowing for the intuitive visualization and performance of complex chord structures. By translating musical intervals into a two-dimensional grid, users can explore tonal gravity, voice leading, and advanced chord extensions using visual memory rather than traditional keyboard linear mapping.
---
### **INSTALL:** select the installer for your Operating System under "Releases".
### **Live WEB VERSION:** [Tonnetz Pro (Browser)](https://cyberchriz.github.io/musictools/ui/index.html) **NOTE: FIREFOX IS STRONGLY RECOMMENDED FOR THE BROWSER VERSION DUE TO SUPERIOR PERFORMANCE.**

---

# Architecture & Features

### Interface & Navigation
* **Tonal Mapping:** perfect fifths on the horizontal axes, major & minor thirds on the diagonals.
* **Triads:** Upward-facing triangles for major triads; downward-facing triangles for minor triads.
* **Extended Chords:** Use multi-touch or "performance pads" panel to add notes or play complex voicings. On desktop: use keyboard shortcuts via key rows QWERT / ASDFG / YXCVB.
* **Sustain / Dampen / Legato / Arpeggio:**: used keyboard shortcuts or "performance pads" panel. The arpeggiator supports directional and randomized arpeggiation with adjustable swing, subdivisions, and continuous looping.
* **Viewport Control:** use the core menu (bottom right) for zoom, pan and various docking panels. The desktop version supports mouse wheel zoom.
* **Scale Overlay:** Select from 20+ scale presets to overlay the grid with color-coded scale nodes.

### Audio Engine & Sampling
* **Dual-Oscillator Synthesizer:** Procedural audio engine featuring 33 pre-calibrated acoustic and analog presets.
* **Hardware-Style Sampler:** Supports internal WAV/OGG file loading, pitch-shifting, and local directory scanning (available in Desktop build).
* **Modulation & Dynamics:** Visual ADSR envelope, multi-LFO system (routing to pitch, amplitude, and filter cutoff), and dedicated sub/noise oscillators.
* **Effects Chain:** Global distortion, chorus, delay, and convolution/algorithmic reverb.

### 8-Track Looper & Drum Machine
* **Live Sequencer:** 4 polyphonic voice tracks and 4 independent drum tracks with overdubbing capabilities.
* **Rhythm Engine:** 16 genre-specific rhythm presets featuring intelligent auto-embellishment (humanized ghost notes and velocity variations). Includes manual trigger pads for finger-drumming.
* **Audio Routing:** Import external backing tracks into the master mix, and export the live master output to uncompressed WAV, MP3, MP4, or WebM.

### Advanced Music Theory Tools
* **Interactive Circle of Fifths:** A synchronized harmonic minimap that tracks and highlights active chord structures in real-time.
* **Scale Constraints:** Snap-to-scale functionality locking the grid to standard modes, pentatonics, or exotic scales (e.g., Lydian Dominant, Hungarian Minor).
* **Tuning Systems:** Switch the engine from Equal Temperament to Just Intonation or Pythagorean Tuning for mathematically perfect, beatless ratios. Use Master Tuning slider e.g. if you prefer A=432 Hz.
* **Dynamic Labels:** Toggle node labels between absolute pitch, scale degrees, Roman numerals, or Solfege.

### Hardware & MIDI Integration
* **MIDI I/O:** Full duplex Web MIDI API support (SLAVE / MASTER). Play the internal engine using USB MIDI controllers, or use Tonnetz Pro as a geometric MIDI controller to drive external DAW hardware.
* **Clock Synchronization:** Configurable MIDI Clock routing. Act as a Master clock to drive external gear, or slave the internal Arpeggiator and Looper to an external tempo.

---

# Local Build (Desktop)

Tonnetz Pro is engineered as a zero-dependency vanilla HTML/JS application wrapped in a native Rust backend via [Tauri](https://tauri.app/). 

**Prerequisites:**
* [Node.js](https://nodejs.org/)
* [Rust Toolchain](https://rustup.rs/)

**Run in Development Mode:**
```bash
npm install
npx tauri dev
```
---
# License

Copyright (c) 2026 Christian Suer (GitHub: cyberchriz). All rights reserved.

<details>
<summary><strong>View Full License Terms</strong></summary>

<br>

> Permission is granted for personal, non-commercial use and execution only. 
> No part of this software may be redistributed or used for 
> commercial purposes without explicit written permission from the author.
> Modification and derivative works are permitted for personal use as local builds
> in accordance with the above terms, but may not be distributed or used commercially.
>
> For commercial licensing inquiries or acquisition offers, please contact 
> the author via GitHub.

</details>

*For more details, see the full [LICENSE.md](LICENSE.md) file.*
