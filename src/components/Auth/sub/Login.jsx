import React, { useEffect, useState, useRef } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';

const baseName = "/3dreconstruction"

const Login = ({ props }) => {
    const { isLoggedIn, setIsLoggedIn, setPage } = props;

    const controllerRef = useRef(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const handleLogin = async (event) => {
        event.preventDefault();

        // Abort previous request
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            // Request to backend for login
            const response = await fetch('http://localhost:3000/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
            })
            const data = await response.json();
            if (data.status === 200) {
                setIsLoggedIn(true);
                // Save login state to localStorage
                localStorage.setItem('authToken', data.authToken)
                localStorage.setItem('username', username);
            } else {
                alert('Invalid username or password');
            }
        } catch (error) {
            console.log(error);
        };
    }

    const handleLogout = () => {
        setIsLoggedIn(false);
        setUsername('');
        setPassword('');

        // Clear login state from localStorage
        localStorage.removeItem('username');
        localStorage.removeItem('password');
    };

    const gotoRegister = () => {
        window.history.replaceState("", "", baseName+"/register");
    }

    return (
        <div className="authPage-container">
            {isLoggedIn ? (
                <div>
                    < h2>Welcome, {username}!</h2>
                    <button className="btn btn-primary" onClick={handleLogout}>Logout</button>
                </div>
            ) : (
                <>
                    <form onSubmit={handleLogin}>
                        <h2>Login</h2>
                        <div className="form-group">
                            <label>Username</label>
                            <input
                                type="text"
                                className="form-control"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                placeholder='Enter your username here'
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label>Password</label>
                            <input
                                type="password"
                                className="form-control"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder='Enter your password here'
                                required
                            />
                        </ div>
                        <button type="submit" id="submit-btn" className="btn btn-primary">Login</button>
                    </form>
                    <button onClick={gotoRegister}>Not registered yet? Sign-up now</button>
                </>
            )}
        </div>
    )
}

export default Login;