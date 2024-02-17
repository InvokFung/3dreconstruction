import { RouterProvider } from "react-router-dom"

import Main from "components/main"

function App() {
  return (
    <RouterProvider>
      <Routes>
        <Route path="/" element={<Main />} />
        {/* <Route path="*" element={<NotFound />} /> */}
      </Routes>
    </RouterProvider>
  )
}

export default App
