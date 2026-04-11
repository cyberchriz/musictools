// Prevents an additional console window on Windows in release builds, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::Manager; // <-- NEW: This allows Rust to talk to the Operating System paths!

#[tauri::command]
fn get_samples(app_handle: tauri::AppHandle) -> Vec<String> {
    let mut samples = Vec::new();
    
    // 1. Default to the developer path (for npx tauri dev)
    let mut folder_path = std::path::PathBuf::from("../ui/samples");

    // 2. If we are in the compiled Release build, ask the OS where the app is actually installed!
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let bundled_path = resource_dir.join("ui").join("samples");
        if bundled_path.exists() {
            folder_path = bundled_path;
        }
    }
    
    // 3. Scan whichever folder we found
    if let Ok(entries) = fs::read_dir(folder_path) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.ends_with(".wav") || name.ends_with(".ogg") || name.ends_with(".mp3") {
                    samples.push(name);
                }
            }
        }
    }
    
    samples.sort();
    samples
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_samples])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}