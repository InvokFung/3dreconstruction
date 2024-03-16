import React, { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './account.css'

function Authentication() {
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    // Load login state from localStorage when component mounts
    useEffect(() => {
        const savedUsername = localStorage.getItem('username');
        const savedPassword = localStorage.getItem('password');        
        if (savedUsername === 'admin' && savedPassword === 'password') {
            setIsLoggedIn(true);
            setUsername(savedUsername);
            setPassword(savedPassword);
        }
    }, []);

    const handleLogin = (event) => {
        event.preventDefault();
        // Dummy authentication function
        if (username === 'admin' && password === 'password') {
            console.log("Saved")
            setIsLoggedIn(prev => true);            
            // Save login state to localStorage
            localStorage.setItem('username', username);
            localStorage.setItem('password', password);
        } else {
            alert('Invalid username or password');
        }
    };

    const handleLogout = () => {
        setIsLoggedIn(false);
        setUsername('');
        setPassword('');

        // Clear login state from localStorage
        localStorage.removeItem('username');
        localStorage.removeItem('password');
    };

    return (
        <div className="auth-container">
            {isLoggedIn ? (
                <div>
                    <div>Welcome, {username}!</div>
                    <div className="btn btn-primary" onClick={handleLogout}>Logout</div>
                </div>
            ) : (
                <div className='btn'>Login</div>
            )}
        </div>
    );
}

export default Authentication;