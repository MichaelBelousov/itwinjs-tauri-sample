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
  ipc: mpsc::Sender<IpcCommand>
  // either have a one shot in every command or put a channel in here for commands to talk back with
}

// FIXME: make non-blocking async
// returns a json string for simplicity
#[tauri::command]
async fn ipcRenderer_invoke(channel: String, json: String, sidecar: tauri::State<'_, SideCar>) -> Result<String, String> {
  {
    let child_opt: &mut Option<CommandChild> = &mut *sidecar.child.lock().unwrap();
    let child: &mut CommandChild = child_opt.as_mut().ok_or(String::from("no sidecar process yet"))?;
    child.write(json.as_bytes()).unwrap();
    child.write("\n".as_bytes()).unwrap();
  }

  let (sender, receiver) = oneshot::channel();
  sidecar.ipc.clone().send(IpcCommand{resp: sender}).await;
  let result = receiver.await;
  return result.unwrap();
}

#[tauri::command]
async fn ipcRenderer_send(state: tauri::State<'_, SideCar>) -> Result<String, String> {
  Ok(String::from("unimplemented"))
}

fn main() {
  let (event_wrap_sender, mut event_wrap_recv) = mpsc::channel(1);

  tauri::Builder::default()
    .manage(SideCar{
      ipc: event_wrap_sender,
      child: Arc::new(Mutex::new(None)),
    })
    .invoke_handler(tauri::generate_handler![ipcRenderer_invoke, ipcRenderer_send])
    .setup(move |app| {
      let window = app.get_window("main").unwrap();

      let global_listener_id = app.listen_global("event-name", |event| {
        println!("got event-name: {:?}", event.payload());
      });
      let state_child = app.state::<SideCar>().child.clone();

      tauri::async_runtime::spawn(async move {
        let (mut rx, mut child) = Command::new_sidecar("node")
          // TODO: go back to using `pkg` to package the node.js code as v8 bytecode for startup performance and hiding source
          .expect("failed to setup `node` sidecar")
          .args(&["binaries/dist/main.js"])
          .spawn()
          .expect("Failed to spawn packaged node");


        *state_child.lock().unwrap() = Some(child);

        while let Some(event) = rx.recv().await {
          if let Some(cmd) = event_wrap_recv.recv().await {
            cmd.resp.send(
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
            );
          }
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

