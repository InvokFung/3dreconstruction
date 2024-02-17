import React, { useEffect, useState, useRef } from 'react';

import './main.css';

const Main = () => {
    const mainContainer = useRef();
    const fileInput = useRef();
    const resultField = useRef();
    const [images, setImages] = useState([]);
    const [result, setResult] = useState(null);
    const [resultRetrieved, setResultRetrieved] = useState(false);

    // =============================================================

    const handleFileUpload = (event) => {
        event.preventDefault();

        setImages(prevImages => [...prevImages, ...Array.from(event.target.files)]);
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    const handleFormSubmit = (event) => {
        event.preventDefault();

        const formData = new FormData();
        images.forEach((image, index) => {
            formData.append('images', image, image.name);
        });

        const userId = 1;

        fetch(`http://localhost:3000/process_image/${userId}`, {
            method: 'POST',
            body: formData
        })
            .then(response => response.blob())  // convert the response to a Blob
            .then(blob => {
                // Create an object URL for the Blob
                let url = URL.createObjectURL(blob);

                // Append the Image object to the body of the document                
                setResult(<img src={url} />);

                setResultRetrieved(true);
            })
            .catch(error => console.error('Error:', error));
    }

    const handleDragOver = (event) => {
        event.preventDefault();
    }

    const handleDrop = (event) => {
        event.preventDefault();

        if (event.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (event.dataTransfer.items[i].kind === 'file') {
                    var file = event.dataTransfer.items[i].getAsFile();
                    var fileType = file.name.split('.').pop().toLowerCase();

                    // Check if file type is jpg, jpeg or png
                    if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                        setImages(prevImages => [...prevImages, file]);
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
                    setImages(prevImages => [...prevImages, event.dataTransfer.files[i]]);
                } else {
                    alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                }
            }
        }
    }

    return (
        <div ref={mainContainer} className='rcs-container'>
            <div className='left-content'>
                {resultRetrieved ? (
                    <>
                        <div className='result-field' ref={resultField}>{result}</div>
                        <div className='option-field'>
                            <button onClick={() => setResultRetrieved(false)}>Upload again</button>
                        </div>
                    </>
                ) : (
                    <>
                        <div
                            className='upload-field'
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onClick={() => fileInput.current.click()}
                        >
                            <div style={{ textAlign: 'center' }}>
                                Drop images here or click to upload
                                <br />
                                Only jpg, jpeg, png files are supported
                            </div>

                            <input
                                ref={fileInput}
                                type="file"
                                onChange={handleFileUpload}
                                onClick={(event) => event.target.value = null}
                                className='file-input'
                                multiple
                                accept=".jpg,.jpeg,.png"
                            />
                        </div>
                        <div className='option-field'>
                            <button onClick={handleFormSubmit}>Convert now</button>
                        </div>
                    </>
                )}
            </div>
            <div className='right-content'>
                <div className='uploaded-gallery'>
                    <div className='ug-header'>Uploaded Images</div>
                    {images.map((image, index) => (
                        <div key={index} style={{ position: 'relative' }}>
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
                                X
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
};

export default Main;