#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  self,
  api::{
    process::{Command, CommandEvent},
  },
  Manager,
};

use std::{
  cell::RefCell,
  path::PathBuf,
};

#[derive(serde::Serialize, Clone, Debug)]
struct Message {
  channel: String,
  json: String,
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let in_tauri_debug = false && cfg!(debug_assertions);
      // TODO: figure out a better way to do this, probably according to tauri:
      let sidecar_path = if !in_tauri_debug {
        let mut path = app.path_resolver().resource_dir().expect("resource dir couldn't be loaded");
        path.push("dist/main.js");
        path
      } else {
        PathBuf::from("dist/main.js")
      };
      let sidecar_path = sidecar_path.as_path().to_str().expect("resource path was invalid");

      let app_dir = if !in_tauri_debug {
        app.path_resolver().app_dir().expect("app dir couldn't be loaded")
      } else {
        PathBuf::from(".dev-app-dir")
      };
      let app_dir = app_dir.as_path().to_str().expect("app dir was invalid");

      let (mut rx, child) = Command::new_sidecar("node")
        // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
        .expect("failed to setup `node` sidecar")
        .args(&["--inspect-brk", sidecar_path, app_dir])
        .spawn()
        .expect("Failed to spawn packaged node");

      let window = app.get_window("main").unwrap();
      // this probably ought to be wrapped in a mutex
      let child_cell = RefCell::new(child);

      window.listen("ipcRenderer_event", move |event| {
        //println!("got ipcRenderer_event! {:?}", event);
        let mut child = child_cell.borrow_mut();
        let payload = event.payload().unwrap();
        println!("sent: '{}'", payload);
        child.write(payload.as_bytes()).unwrap();
        child.write("\n".as_bytes()).unwrap();
      });

      tauri::async_runtime::spawn(async move {
        while let Some(cmd) = rx.recv().await  {
          //println!("got cmd: {:?}", cmd);
          match cmd {
            CommandEvent::Stdout(json) => {
              println!("received: '{}'", json);
              window
                .emit("ipcRenderer_event_respond", Message { json, channel: "ipcRenderer_invoke".into() })
                .expect("emitting ipcRenderer event response failed");
            }
            CommandEvent::Stderr(json) => { println!("got stderr: {:?}", json); }
            CommandEvent::Terminated(payload) => { println!("got terminated: {:?}", payload); }
            _ => { println!("got unknown!"); }
          };
        }
        println!("error child had None response");
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
