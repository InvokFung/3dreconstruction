import { BrowserRouter, Routes, Route } from "react-router-dom"
import Main from "components/main"
import NotFound from "./components/main/NotFound"

function App() {
  return (
    <BrowserRouter basename={"/3dreconstruction"}>
      <Routes>
        <Route path="" element={<Main />} />
        <Route path="test" element={<Main />} />        
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
