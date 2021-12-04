#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  api::process::{Command, CommandEvent, CommandChild},
  Manager,
};

use std::{
  cell::RefCell,
};

#[derive(serde::Serialize, Clone)]
struct Message {
  channel: String,
  json: String,
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let (mut rx, mut child) = Command::new_sidecar("node")
        // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
        .expect("failed to setup `node` sidecar")
        .args(&[
          //"--inspect",
          "--inspect-brk",
          "binaries/dist/main.js"
        ])
        .spawn()
        .expect("Failed to spawn packaged node");

      let window = app.get_window("main").unwrap();

      let child_cell = RefCell::new(child);

      window.listen("ipcRenderer_event", move |event| {
        println!("got ipcRenderer_event! {:?}", event);
        let mut child = child_cell.borrow_mut();
        child.write(event.payload().unwrap_or("<none>").as_bytes()).unwrap();
        child.write("\n".as_bytes()).unwrap();
      });

      tauri::async_runtime::spawn(async move {
        println!("started ipcRenderer_responder");
        if let Some(cmd) = rx.recv().await {
          println!("got cmd {:?}", cmd);
          window.emit("ipcRenderer_event_respond",
            match cmd {
              CommandEvent::Stdout(json) => {
                println!("stdout! '{}'", json);
                Message { json, channel: "ipcRenderer_invoke".into() }
              }
              CommandEvent::Stderr(json) => {
                println!("stderr! '{}'", json);
                Message { json, channel: "ipcRenderer_invoke_err".into() }
              }
              CommandEvent::Terminated(payload) => {
                println!("terminated! '{:?}'", payload);
                //Err("sidecar terminated".into())
                Message { json: "terminated!".into(), channel: "ipcRenderer_invoke_term".into() }
              }
              _ => {
                println!("unknown!");
                //Err("unknown command event".into())
                Message { json: "unknown!".into(), channel: "ipcRenderer_invoke_unknown".into() }
              }
            }
          );
        } else {
          println!("error child had None response")
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

