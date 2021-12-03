#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  api::process::{Command, CommandEvent, CommandChild},
  Manager,
};

use tokio::sync::{oneshot, mpsc::{self, Receiver, Sender}};

use std::{
  sync::{Arc, Mutex},
  cell::RefCell,
};

#[derive(serde::Serialize)]
struct Message {
  channel: String,
  json: String,
}

struct IpcCommand {
  //req: String,
  resp: oneshot::Sender<Result<String, String>>
}

//#[derive(Default)]
struct SideCar {
  // https://tokio.rs/tokio/tutorial/channels
  child: Arc<Mutex<Option<CommandChild>>>,
  ipc: Arc<tokio::sync::Mutex<Option<mpsc::Sender<IpcCommand>>>>
  // either have a one shot in every command or put a channel in here for commands to talk back with
}

fn main() {
  tauri::Builder::default()
    .manage(SideCar{
      ipc: Arc::new(tokio::sync::Mutex::new(None)),
      child: Arc::new(Mutex::new(None)),
    })
    .invoke_handler(tauri::generate_handler![ipcRenderer_invoke, ipcRenderer_send])
    .setup(move |app| {
      let window = app.get_window("main").unwrap();

      tauri::async_runtime::spawn(async move {
        let (mut rx, mut child) = Command::new_sidecar("node")
          // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
          .expect("failed to setup `node` sidecar")
          .args(&["binaries/dist/main.js"])
          .spawn()
          .expect("Failed to spawn packaged node");

        app.listen_global("ipcRenderer_invoke", |event| {
          tauri::async_runtime::spawn(async move {
            child.write(event.payload().as_bytes()).unwrap();
            child.write("\n".as_bytes()).unwrap();
            if let Some(cmd) = rx.recv().await {
              app.emit_all("ipcRenderer_invoke",
                match event {
                  CommandEvent::Stdout(json) => {
                    println!("stdout! '{}'", line);
                    Message { json, channel: "ipcRenderer_invoke" }
                  }
                  CommandEvent::Stderr(json) => {
                    println!("stderr! '{}'", line);
                    Message { json, channel: "ipcRenderer_invoke_err" }
                  }
                  CommandEvent::Terminated(payload) => {
                    println!("terminated! '{:?}'", payload);
                    Err("sidecar terminated".into())
                  }
                  _ => {
                    println!("unknown!");
                    Err("unknown command event".into())
                  }
                }
              );
            } else {
              println!("error child had None response")
            }
          });
        });
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

