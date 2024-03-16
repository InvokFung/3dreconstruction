import React, { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';

const Register = ({ props }) => {
    const { isLoggedIn, setIsLoggedIn, setPage } = props;

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const handleRegister = (event) => {
        event.preventDefault();
        // Request to backend for login
        fetch('http://localhost:3000/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username, password }),
        })
            .then(response => response.json())
            .then(data => {
                console.log(data)
                if (data.status === 200) {
                    setIsLoggedIn(true);
                    // Save login state to localStorage                    
                    localStorage.setItem('authToken', data.authToken)
                    localStorage.setItem('username', username);
                } else {
                    alert('Username already exist, please try another username');
                }
            })
    };

    return (
        <div className="authPage-container">
            {isLoggedIn ? (
                <div>
                    < h2>Welcome, {username}!</h2>
                    <button className="btn btn-primary" onClick={handleLogout}>Logout</button>
                </div>
            ) : (
                <>
                    <form onSubmit={handleRegister}>
                        <h2>Sign-up</h2>
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
                        <button type="submit" id="submit-btn" className="btn btn-primary">Register</button>
                    </form>
                    <button onClick={setPage('login')}>Already have an account? Login now</button>
                </>
            )}
        </div>
    )
}

export default Register;