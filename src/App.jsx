import { HashRouter } from "react-router-dom"

import Main from "components/main"

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Main />} />
        {/* <Route path="*" element={<NotFound />} /> */}
      </Routes>
    </HashRouter>
  )
}

export default App
