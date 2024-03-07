import { Routes, Route } from "react-router-dom"
import Main from "components/main"

function App() {
  return (
    <Routes>
      <Route path="/" element={<Main />} />
      {/* <Route path="*" element={<NotFound />} /> */}
    </Routes>
  )
}

export default App
