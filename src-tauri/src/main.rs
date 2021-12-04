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

#[derive(serde::Serialize, Clone)]
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
    //.invoke_handler(tauri::generate_handler![ipcRenderer_invoke, ipcRenderer_send])
    .setup(|app| {

      let (mut rx, mut child) = Command::new_sidecar("node")
        // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
        .expect("failed to setup `node` sidecar")
        .args(&["binaries/dist/main.js"])
        .spawn()
        .expect("Failed to spawn packaged node");

      let window = app.get_window("main").unwrap();

      let child_cell = RefCell::new(child);

      window.listen("ipcRenderer_event", move |event| {
        child_cell.borrow_mut().write(event.payload().unwrap_or("<none>").as_bytes()).unwrap();
        child_cell.borrow_mut().write("\n".as_bytes()).unwrap();
      });

      tauri::async_runtime::spawn(async move {
        if let Some(cmd) = rx.recv().await {
          window.emit("ipcRenderer_invoke",
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

