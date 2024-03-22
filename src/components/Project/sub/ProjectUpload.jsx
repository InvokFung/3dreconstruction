import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

const ProjectUpload = ({ props }) => {
    const {
        stage,
        setStage,
        page,
        setPage,
    } = props;

    const {
        authenticated,
        setAuthenticated,
        userData,
        setUserData,
        updateUserData,
        authChecked,
        setAuthChecked,
        controllerRef
    } = useSocket();

    const { projectId } = useParams();
    const navigateTo = useNavigate();

    //
    const fileInput = useRef();
    const nextBtnRef = useRef();

    const [uploaded, setUploaded] = useState(false);
    const [images, setImages] = useState([]);

    const handleFileUpload = (event) => {
        event.preventDefault();

        setImages(prevImages => [...prevImages, ...Array.from(event.target.files)]);
        setUploaded(true);
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    const handleClick = (event) => {
        fileInput.current.click()
    }

    const handleDragOver = (event) => {
        event.preventDefault();
    }

    const handleDrop = (event) => {
        event.preventDefault();

        let newImages = [...images];  // Create a copy of the current images

        if (event.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (event.dataTransfer.items[i].kind === 'file') {
                    var file = event.dataTransfer.items[i].getAsFile();
                    var fileType = file.name.split('.').pop().toLowerCase();

                    // Check if file type is jpg, jpeg or png
                    if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                        newImages.push(file);
                    } else {
                        alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                    }
                }
            }
        } else {
            // Use DataTransfer interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.files.length; i++) {
                var fileType = event.dataTransfer.files[i].name.split('.').pop().toLowerCase();

                // Check if file type is jpg, jpeg or png
                if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                    newImages.push(event.dataTransfer.files[i]);
                } else {
                    alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                }
            }
        }
        setImages(newImages);
        setUploaded(true);
    }

    const handleBeforeUnload = (event) => {
        event.preventDefault();
        event.returnValue = true;
    }

    const gotoNextStage = async () => {
        // Disable the button to prevent multiple clicks
        nextBtnRef.current.disabled = true;

        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const action = "add";

        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);
        formData.append('action', action);

        images.forEach((image, index) => {
            formData.append('images', image, image.name);
        });

        try {
            const projectUrl = `http://localhost:3000/projectUpload`;
            const response = await fetch(projectUrl, {
                method: "POST",
                body: formData,
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setStage(2);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
            nextBtnRef.current.disabled = false;
        }
    }

    useEffect(() => {
        if (images.length == 0) {
            setUploaded(false);
        }
    }, [images])

    useEffect(() => {
        if (uploaded)
            window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        }
    }, [uploaded])

    // =============================================================

    return (
        <>
            <div id="project-upload" className="project-field">
                <div className='project-header'>
                    <span>Step 1. Upload your images</span>
                    <div id="upload-guide" className="guide" title="View Guideline">?</div>
                </div>

                <div className="upload-form">
                    {uploaded ? (
                        <div className="upload-viewer">
                            <div className="upload-wrapper">
                                {images.map((image, index) => (
                                    <div className="image-box" key={index}>
                                        <img
                                            src={URL.createObjectURL(image)}
                                            alt={`Uploaded Image ${index}`}
                                            className='uploaded-image'
                                        />
                                        <div
                                            onClick={() => handleRemoveImage(index)}
                                            className='remove-image-btn'
                                            title="Remove image"
                                        >
                                            -
                                        </div>
                                    </div>
                                ))}
                                <div id="upload-extra" className="image-box" onClick={handleClick}>
                                    +
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div
                            className='upload-field'
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onClick={handleClick}
                        >
                            <div style={{ textAlign: 'center' }}>
                                Drop images here or click to upload
                                <br />
                                Only jpg, jpeg, png files are supported
                            </div>
                        </div>
                    )}
                    <input
                        ref={fileInput}
                        type="file"
                        onChange={handleFileUpload}
                        onClick={(event) => event.target.value = null}
                        className='file-input'
                        multiple
                        accept=".jpg,.jpeg,.png"
                        style={{ display: 'none' }}
                    />
                </div>
                <div className="submit-field">
                    <div id="next-btn" className="btn buttonFilled" onClick={gotoNextStage} ref={nextBtnRef}>Next</div>
                </div>
            </div>
        </>
    )
};

export default ProjectUpload;