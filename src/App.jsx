import { Routes, Route } from "react-router-dom"
import Main from "components/main"

import process from "process";
import { Buffer } from "buffer";
import EventEmitter from "events";

function App() {
  window.Buffer = Buffer;
  window.process = process;
  window.EventEmitter = EventEmitter;
  
  return (
    <Routes>
      <Route path="/" element={<Main />} />
      {/* <Route path="*" element={<NotFound />} /> */}
    </Routes>
  )
}

export default App
