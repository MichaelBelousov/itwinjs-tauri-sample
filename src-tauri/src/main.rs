#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
  api::process::{Command, CommandEvent, CommandChild},
  async_runtime::Receiver,
  Manager,
  //Runtime,
};

use std::{
  sync::{Arc, Mutex},
  boxed::Box,
};

#[derive(serde::Serialize)]
struct Message {
  channel: String,
}

//#[derive(Default)]
struct SideCar {
  // https://tokio.rs/tokio/tutorial/shared-state#holding-a-mutexguard-across-an-await
  recv: Arc<Mutex<Option<Receiver<CommandEvent>>>>,
  child: Arc<Mutex<Option<CommandChild>>>,
}

// FIXME: make non-blocking async
// returns a json string for simplicity
#[tauri::command]
fn ipcRenderer_invoke(json: String, sidecar: tauri::State<'_, SideCar>) -> Result<String, String> {

  let child_opt: &mut Option<CommandChild> = &mut *sidecar.child.lock().unwrap();
  let child: &mut CommandChild = child_opt.as_mut().ok_or(String::from("no sidecar process yet"))?;
  child.write(json.as_bytes()).unwrap();
  child.write("\n".as_bytes()).unwrap();

  let rx: Arc<Mutex<Option<Receiver<CommandEvent>>>> = sidecar.recv.clone();
  let mut rx : std::sync::MutexGuard<'_, Option<Receiver<CommandEvent>>> = rx.lock().unwrap();
  let rx: &mut Receiver<CommandEvent> = rx.as_mut().ok_or(String::from("no sidecar process yet"))?;
  let maybe_event = rx.blocking_recv();

  if let Some(event) = maybe_event {
    match event {
      CommandEvent::Stdout(line) => {
        println!("stdout! '{}'", line);
        Ok(line)
      }
      CommandEvent::Stderr(line) => {
        println!("stderr! '{}'", line);
        Err("stderr received".into())
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
  } else {
    Err("event was none!".into())
  }
}

#[tauri::command]
async fn ipcRenderer_send(state: tauri::State<'_, SideCar>) -> Result<String, String> {
  Ok(String::from("unimplemented"))
}

fn main() {
  tauri::Builder::default()
    .manage(SideCar{
      recv: Arc::new(Mutex::new(None)),
      child: Arc::new(Mutex::new(None)),
    })
    .invoke_handler(tauri::generate_handler![ipcRenderer_invoke, ipcRenderer_send])
    .setup(|app| {
      let window = app.get_window("main").unwrap();

      let global_listener_id = app.listen_global("event-name", |event| {
        println!("got event-name: {:?}", event.payload());
      });

      let state_recv = app.state::<SideCar>().recv.clone();
      let state_child: Arc<Mutex<Option<CommandChild>>> = app.state::<SideCar>().child.clone();

      tauri::async_runtime::spawn(async move {
        let (mut rx, mut child) = Command::new_sidecar("node")
          // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
          .expect("failed to setup `node` sidecar")
          .args(&["binaries/dist/main.js"])
          .spawn()
          .expect("Failed to spawn packaged node");

        *state_recv.lock().unwrap() = Some(rx);
        *state_child.lock().unwrap() = Some(child);
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

