import React, { useEffect, useState, useRef } from 'react';

import './main.css';

const Main = () => {
    const mainContainer = useRef();
    const fileInput = useRef();
    const resultField = useRef();

    const depthMinVal = useRef();
    const depthMaxVal = useRef();
    const fxVal = useRef();
    const fyVal = useRef();
    const cxVal = useRef();
    const cyVal = useRef();

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
        
        if (images.length === 0) {
            return alert("No images were uploaded");
        }

        console.log(`Requesting ${images.length} images`)

        const formData = new FormData();
        images.forEach((image, index) => {
            formData.append('images', image, image.name);
        });

        // Add extra parameters
        const parameters = {
            depthMin: depthMinVal.current.value,
            depthMax: depthMaxVal.current.value,
            fx: fxVal.current.value,
            fy: fyVal.current.value,
            cx: cxVal.current.value,
            cy: cyVal.current.value
        };

        // Convert parameters to JSON string
        const parametersJson = JSON.stringify(parameters);

        // Append parameters to formData
        formData.append('parameters', parametersJson);

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
                <div className='rcs-parameter'>
                    <div className='rp-header'>Parameters</div>
                    <div className='rp-content'>
                        <div className='rp-item'>
                            <div>Object Depth</div>
                            <div className='multiInput'>
                                <div className='halfText'>
                                    <label>min</label>
                                    <input className='halfInput' type='number' step="0.01" ref={depthMinVal} defaultValue={0} />
                                </div>
                                <div className='halfText'>
                                    <label>max</label>
                                    <input className='halfInput' type='number' step="0.01" ref={depthMaxVal} defaultValue={0} />
                                </div>
                            </div>
                        </div>
                        <div className='rp-item'>
                            <div>Camera focal length</div>
                            <div className='multiInput'>
                                <div className='halfText'>
                                    <label>fx</label>
                                    <input className='halfInput' type='number' step="0.01" ref={fxVal} defaultValue={0} />
                                </div>
                                <div className='halfText'>
                                    <label>fy</label>
                                    <input className='halfInput' type='number' step="0.01" ref={fyVal} defaultValue={0} />
                                </div>
                            </div>
                        </div>
                        <div className='rp-item'>
                            <div>Image center position</div>
                            <div className='multiInput'>
                                <div className='halfText'>
                                    <label>cx</label>
                                    <input className='halfInput' type='number' step="0.01" ref={cxVal} defaultValue={0} />
                                </div>
                                <div className='halfText'>
                                    <label>cy</label>
                                    <input className='halfInput' type='number' step="0.01" ref={cyVal} defaultValue={0} />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
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