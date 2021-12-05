#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  api::process::{Command, CommandEvent},
  Manager,
};

use std::{
  cell::RefCell,
};

#[derive(serde::Serialize, Clone, Debug)]
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
          "--inspect",
          //"--inspect-brk",
          "binaries/dist/main.js"
        ])
        .spawn()
        .expect("Failed to spawn packaged node");

      let window = app.get_window("main").unwrap();
      // this probably ought to be wrapped in a mutex
      let child_cell = RefCell::new(child);

      window.listen("ipcRenderer_event", move |event| {
        println!("got ipcRenderer_event! {:?}", event);
        let mut child = child_cell.borrow_mut();
        child.write(event.payload().unwrap().as_bytes()).unwrap();
        child.write("\n".as_bytes()).unwrap();
      });

      tauri::async_runtime::spawn(async move {
        while let Some(cmd) = rx.recv().await  {
          println!("got cmd: {:?}", cmd);
          match cmd {
            CommandEvent::Stdout(json) => {
              window.emit("ipcRenderer_event_respond", Message { json, channel: "ipcRenderer_invoke".into() });
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
