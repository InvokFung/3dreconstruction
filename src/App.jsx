import { HashRouter, Routes, Route } from "react-router-dom"
import { Link } from "react-router-dom"
import Home from "components/Home"
import Profile from "components/Auth/Profile"
import Register from "components/Auth/Register"
import Login from "components/Auth/Login"
import NotFound from "components/Notfound"
import { SocketProvider } from "utils/SocketProvider"
import Project from "components/Project"
import ProjectList from "components/ProjectList"
import ProjectResult from "components/Project/sub/ProjectResult"
import './index.css';

function App() {
  return (
    <SocketProvider>
      <HashRouter>
        <Routes>
          <Route exact path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route path="/project/:projectId" element={<Project />} />
          <Route path="/project/:projectId/:tab" element={<ProjectResult />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </HashRouter>
    </SocketProvider>
  )
}

export default App
